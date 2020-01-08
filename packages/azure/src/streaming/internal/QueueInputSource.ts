/*
Copyright (c) Walmart Inc.

This source code is licensed under the Apache 2.0 license found in the
LICENSE file in the root directory of this source tree.
*/

import {
    EventSourcedMetadata,
    failSpan,
    IComponentContext,
    IInputSource,
    ILogger,
    IMessageEncoder,
    IMetadata,
    IMetrics,
    IRequireInitialization,
    isEmbeddable,
    MessageRef,
} from "@walmartlabs/cookie-cutter-core";
import { FORMAT_HTTP_HEADERS, Tags, Tracer } from "opentracing";
import { isArray } from "util";
import { IQueueConfiguration, QueueMetadata } from "..";
import { IQueueReadOptions, QueueClient, QueueOpenTracingTagKeys } from "../../utils";

enum QueueMetrics {
    ApproximateMessageCount = "cookie_cutter.azure_queue_consumer.approximate_message_count",
}

interface IBufferToJSON {
    type: string;
    data: any[];
}

export class QueueInputSource implements IInputSource, IRequireInitialization {
    private readonly client: QueueClient & IRequireInitialization;
    private readonly readOptions: IQueueReadOptions;
    private readonly encoder: IMessageEncoder;
    private metrics: IMetrics;
    private logger: ILogger;
    private tracer: Tracer;
    private running = false;
    private loop: NodeJS.Timer;
    private config: IQueueConfiguration & IQueueReadOptions;

    constructor(config: IQueueConfiguration & IQueueReadOptions) {
        this.config = config;
        this.client = new QueueClient(config);
        this.readOptions = config;
        this.encoder = config.encoder;
    }

    public async initialize(context: IComponentContext): Promise<void> {
        this.metrics = context.metrics;
        this.logger = context.logger;
        this.tracer = context.tracer;
        await this.client.initialize(context);
    }

    public async *start(): AsyncIterableIterator<MessageRef> {
        this.running = true;
        // tslint:disable-next-line:no-floating-promises
        this.loopQueueApproximateCount();
        while (this.running) {
            const messages = await this.client.read(undefined, this.readOptions);
            for (const message of messages) {
                const { headers, payload } = JSON.parse(message.messageText) as {
                    headers: any;
                    payload: IBufferToJSON | any;
                };
                const event_type = headers[EventSourcedMetadata.EventType];
                let protoOrJsonPayload = payload;
                if (payload.type && payload.type === "Buffer" && isArray(payload.data)) {
                    protoOrJsonPayload = payload.data;
                }
                const msg = this.decode(protoOrJsonPayload, event_type);
                const spanContext = this.tracer.extract(FORMAT_HTTP_HEADERS, headers);
                const span = this.tracer.startSpan("Processing Azure Queue Message", {
                    childOf: spanContext,
                });
                span.setTag(Tags.SPAN_KIND, Tags.SPAN_KIND_MESSAGING_CONSUMER);
                span.setTag(Tags.MESSAGE_BUS_DESTINATION, this.readOptions.queueName);
                span.setTag(Tags.COMPONENT, "cookie-cutter-azure");
                span.setTag(Tags.DB_INSTANCE, this.config.storageAccount);
                span.setTag(Tags.DB_TYPE, "AzureQueue");
                span.setTag(Tags.PEER_SERVICE, "AzureQueue");
                span.setTag(Tags.SAMPLING_PRIORITY, 1);
                span.setTag(QueueOpenTracingTagKeys.QueueName, this.readOptions.queueName);
                const metadata: IMetadata = {
                    [QueueMetadata.VisibilityTimeout]: message.timeNextVisible,
                    [QueueMetadata.DequeueCount]: message.dequeueCount,
                };

                const msgRef = new MessageRef(metadata, msg, span.context());
                msgRef.once("released", async (_msg: MessageRef, _value?: any, error?: Error) => {
                    try {
                        if (!error) {
                            await this.client.markAsProcessed(
                                span.context(),
                                message.messageId,
                                message.popReceipt,
                                message.queue
                            );
                        } else {
                            span.log({ reprocess: true });
                            failSpan(span, error);
                        }
                    } finally {
                        span.finish();
                    }
                });
                yield msgRef;

                if (!this.running) {
                    break;
                }
            }
        }
    }

    public async stop(): Promise<void> {
        this.running = false;
        if (this.loop) {
            clearTimeout(this.loop);
        }
    }

    private loopQueueApproximateCount = async () => {
        const queue = this.readOptions.queueName;
        try {
            const { approximateMessageCount } = await this.client.queueMetadata(undefined, queue);
            this.metrics.gauge(QueueMetrics.ApproximateMessageCount, approximateMessageCount, {
                queue,
                storage_account: this.config.storageAccount,
            });
        } catch (error) {
            this.logger.error("QueueInputSource|Failed to fetch queueMetadata", error, { queue });
        }
        if (this.running) {
            this.loop = setTimeout(this.loopQueueApproximateCount, 1000);
        }
    };

    private decode(payload: any, event_type: string) {
        if (isEmbeddable(this.encoder)) {
            return this.encoder.decode(this.encoder.fromJsonEmbedding(payload), event_type);
        }
        return this.encoder.decode(payload, event_type);
    }
}