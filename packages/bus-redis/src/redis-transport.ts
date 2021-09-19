import { Event, Command, Message, MessageAttributes, MessageAttributeMap } from '@node-ts/bus-messages'
import { Transport, TransportMessage, BUS_SYMBOLS, MessageSerializer, HandlerRegistry } from '@node-ts/bus-core'
import { inject, injectable } from 'inversify'
import { BUS_REDIS_SYMBOLS } from './bus-redis-symbols'
import { LOGGER_SYMBOLS, Logger } from '@node-ts/logger-core'
import Redis from 'ioredis'
import { RedisTransportConfiguration } from './redis-transport-configuration'
import { ModestQueue, Message as QueueMessage } from 'modest-queue'


export const DEFAULT_MAX_RETRIES = 10

export type Connection = Redis.Redis
declare type Uuid = string

interface Payload {
  message: string,
  correlationId: Uuid | undefined
  attributes: MessageAttributeMap
  stickyAttributes: MessageAttributeMap
}

/**
 * A Redis transport adapter for @node-ts/bus.
 */
@injectable()
export class RedisTransport implements Transport<QueueMessage> {
  private queue: ModestQueue
  private maxRetries: number

  /**
   * Where we store the subscription keys. When a message is published on the bus
   * we first need to check what queues are interested in receiving that message, and push
   * it to all of them respectively.
   */
  private subscriptionsKeyPrefix: string
  /**
   * Redis client used exclusively for finding out which queues need to know about which commands/events
   */
  private connection: Connection

  constructor (
    @inject(BUS_REDIS_SYMBOLS.TransportConfiguration)
      private readonly configuration: RedisTransportConfiguration,
    @inject(LOGGER_SYMBOLS.Logger) private readonly logger: Logger,
    @inject(BUS_SYMBOLS.MessageSerializer)
      private readonly messageSerializer: MessageSerializer,
    @inject(BUS_SYMBOLS.HandlerRegistry)
      private readonly handlerRegistry: HandlerRegistry,
  ) {
    this.maxRetries = configuration.maxRetries ?? DEFAULT_MAX_RETRIES
    this.subscriptionsKeyPrefix = 'node-ts:bus-redis:subscriptions:'
  }

  async initialize (): Promise<void> {
    this.logger.info('Initializing Redis transport')
    this.connection = new Redis(this.configuration.connectionString)
    // Subscribe this queue to listen to all messages in the HandlerRegistry
    await this.subscribeToMessagesOfInterest()
    this.queue = new ModestQueue({
      queueName: this.configuration.queueName,
      connectionString: this.configuration.connectionString,
      visibilityTimeout: this.configuration.visibilityTimeout ?? 30000,
      maxAttempts: this.configuration.maxRetries ?? DEFAULT_MAX_RETRIES,
      withScheduler: this.configuration.withScheduler,
      withDelayedScheduler: false
    })
    await this.queue.initialize()

    this.logger.info('Redis transport initialized')
  }


  async dispose (): Promise<void> {
    await this.queue.dispose()
    await this.connection.quit()
    this.logger.info('Redis transport disposed')
  }

  async publish<TEvent extends Event> (event: TEvent, messageAttributes?: MessageAttributes): Promise<void> {
    await this.publishMessage(event, messageAttributes)
  }

  async send<TCommand extends Command> (command: TCommand, messageAttributes?: MessageAttributes): Promise<void> {
    await this.publishMessage(command, messageAttributes)
  }

  async fail (message: TransportMessage<QueueMessage>): Promise<void> {
    // Override any configured retries
    await this.queue.messageFailed(message.raw, true)
  }

  async readNextMessage (): Promise<TransportMessage<QueueMessage> | undefined> {
    const maybeMessage = await this.queue.pollForMessage()

    if (!maybeMessage) {
      return undefined
    }

    this.logger.debug('Received message from Redis', {redisMessage: maybeMessage.message})
    const { message, ...attributes}: Payload = JSON.parse(maybeMessage.message)
    const domainMessage = this.messageSerializer.deserialize(message)

    return {
      id: maybeMessage.metadata.token,
      domainMessage,
      raw: maybeMessage,
      attributes
    }
  }

  async deleteMessage (message: TransportMessage<QueueMessage>): Promise<void> {
    this.logger.debug(
      'Deleting message',
      {
        rawMessage: {
          ...message.raw,
          content: message.raw.message
        }
      }
    )
    await this.queue.messageSucceeded(message.raw)
  }

  async returnMessage (message: TransportMessage<QueueMessage>): Promise<void> {
    const failedJobMessage =
      `Failed job: ${message.id}. Attempt: ${message.raw.metadata.currentAttempt}/${this.maxRetries}`
    this.logger.debug(failedJobMessage)
    // modest-queue supports automatic retry, we simply need to state that it failed.
    await this.queue.messageFailed(message.raw)
  }
  /**
   * Associate @see this.queueName with the handlerRegistry's messageSubscriptions. In this way, if another redis-transport
   * publishes a message this queue would also get the message.
   */
  private async subscribeToMessagesOfInterest():Promise<void> {
    const queueSubscriptionPromises = this.handlerRegistry.messageSubscriptions
      .filter(subscription => !!subscription.messageType)
      .map(async subscription => {
        if (subscription.messageType) {
          const messageCtor = subscription.messageType
          return this.connection.sadd(`${this.subscriptionsKeyPrefix}${new messageCtor().$name}`, this.configuration.queueName)
        } else {
          throw new Error(`Unable to messageType to this queue: ${subscription}`)
        }
      })
    this.logger.info('Subscribe queue to messages in HandlerRegistry')
    await Promise.all(queueSubscriptionPromises)
  }
  /**
   * Finds all queues that have handlers subscribed to this message type. @see this.publishMessage must publish this message to all
   * those queues.
   */
  private async getQueuesSubscribedToMessage<TEvent extends Event>(event: TEvent): Promise<string[]> {
    return this.connection.smembers(`${this.subscriptionsKeyPrefix}${event.$name}`)
  }
  /**
   * Serializes the message, appending the MessageAttributes. Publishes to all queues that need
   * have MessageHandlers for this message.$name
   * @param message
   * @param messageOptions
   */
  private async publishMessage (
    message: Message,
    messageOptions: MessageAttributes = new MessageAttributes()
  ): Promise<void> {
    const payload: Payload = {
      message: this.messageSerializer.serialize(message),
      correlationId: messageOptions.correlationId,
      attributes: messageOptions.attributes,
      stickyAttributes: messageOptions.stickyAttributes
    }
    this.logger.debug('Sending message to Redis', {payload})
    const serializedPayload = JSON.stringify(payload)
    const queues = await this.getQueuesSubscribedToMessage(message)
    const queuePublishResults = await Promise.allSettled(queues.map(queue => this.publishMessageToQueue(serializedPayload, queue)))
    const queuesThatFailedPublish = queuePublishResults
      .map((queuePublishResult, index) => ({status: queuePublishResult.status, index}))
      .filter(queuePublishResultWithIndex => queuePublishResultWithIndex.status === 'rejected')
    if (queuesThatFailedPublish.length) {
      // some of the queues that needed to have this message failed to be published to
      const failedQueues = queues
        .filter((_, index) => queuesThatFailedPublish.find(queueThatFailedPublish => queueThatFailedPublish.index === index))
        throw new Error(`Failed to publish message: ${serializedPayload} to the following queues: ${failedQueues.join(', ')}`)
    }
  }

  /**
   * Attempts to publish the message to all queues that have message handlers that are interested in this message
   * @param payload - the serialised payload to place on the queue
   * @param queueName - the name of the redis queue to publish to
   * @param attempt - we try to publish the message to the queue 3 times, logging an error if it fails.
   */
  private async publishMessageToQueue(payload: string, queueName: string, attempt = 0): Promise<void> {
    if (attempt >= 3) {
      throw new Error('Failed to publish message to Transport Queue')
    }
    try {
      const queue = new ModestQueue({queueName, connection: this.connection, withScheduler: false, withDelayedScheduler: false})
      await queue.initialize()
      await queue.publish(payload)
      await queue.dispose()
    } catch (e) {
      return this.publishMessageToQueue(payload, queueName, attempt++)
    }
  }
}