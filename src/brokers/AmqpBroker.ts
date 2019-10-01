import { AbstractBroker, DefinitionHandlerPair } from "./AbstractBroker";
import { RequestMapper, BaseRouteDefinition, RouteMapper } from "./IBroker";
import { Message, Connection, Channel, connect, ConsumeMessage } from "amqplib";
import { Action } from "../decorators/BaseDecorators";
import { Inject } from "../di/DiDecorators";
export class AmqpBroker extends AbstractBroker {
    private connection!: Connection;
    private channel!: Channel;
    constructor(
        @Inject("amqpOptions")
        private options: {
            url: string;
        }) {
        super();
    }
    protected requestMapper: RequestMapper = (r: Message, queue: string, json: boolean) => {
        const payloadString = r.content.toString();
        let payload: any;
        if (json) {
            payload = JSON.parse(payloadString);
        }
        else {
            payload = payloadString;
        }
        const act: Action = {
            request: {
                params: {},
                path: queue,
                headers: r.properties.headers,
                // method: def.method,
                body: payload,
                qs: {},
                raw: r
            },
            connection: this.connection
        };
        return act;
    };
    protected routeMapper: RouteMapper = (def: BaseRouteDefinition) => {
        return `${def.base}.${def.controller}.${def.handler}`.replace('/', '.');
    };
    private async registerRoutes() {
        this.registeredRoutes.forEach(async (value: DefinitionHandlerPair[], route: string) => {
            let json = false;
            let totalConsumers = 0;
            value.forEach(v => {
                const consumers = v.def.consumers || 1;
                if (v.def.json) {
                    json = true;
                }
                totalConsumers += consumers;
            });
            if (totalConsumers > 0) {
                await this.channel.assertQueue(route, { autoDelete: true });
                for (let i = 0; i < totalConsumers; i++) {
                    await this.channel.consume(route, async (message: ConsumeMessage | null) => {
                        if (message) {
                            const mapped: Action = this.requestMapper(message, route, json);
                            const handler = this.actionToRouteMapper(route, mapped, value);
                            const result = await handler(mapped);
                            console.log("MESSAGE", message.properties);
                            if (result && message.properties.replyTo && message.properties.correlationId) {
                                await this.rpcReply(result, message.properties.replyTo, message.properties.correlationId);
                            }
                            await this.channel.ack(message);
                        }
                    });
                }
            }
        });
    }
    private async rpcReply(data: Action, replyToQueue: string, correlationId: string) {
        const response = data.response || {};
        const body = response.body;
        const headers = response.headers;
        await this.channel.sendToQueue(replyToQueue, Buffer.from(JSON.stringify(body)), { correlationId, headers });
    }
    public async start(): Promise<void> {
        this.connection = await connect(this.options.url);
        this.channel = await this.connection.createChannel();
        await this.registerRoutes();
        console.log(`AMQP Connected on path ${this.options.url}`);
    }
}
