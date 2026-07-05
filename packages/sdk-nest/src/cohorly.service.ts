import { Inject, Injectable } from "@nestjs/common";
import type { OnApplicationShutdown } from "@nestjs/common";
import { CohorlyNode } from "@cohorly/node";
import type {
  BatchEventInput,
  Callback,
  CohorlyPeople,
  Properties,
} from "@cohorly/node";
import { COHORLY_MODULE_OPTIONS } from "./cohorly.constants.js";
import type { CohorlyModuleOptions } from "./interfaces.js";

/**
 * Injectable wrapper around a {@link CohorlyNode} client. Delegates the
 * mixpanel-node-style API (track / people / alias / flush) and performs a
 * final flush on application shutdown (stops the auto-flush timer too).
 */
@Injectable()
export class CohorlyService implements OnApplicationShutdown {
  /** The underlying @cohorly/node client, for full API access. */
  readonly client: CohorlyNode;

  constructor(
    @Inject(COHORLY_MODULE_OPTIONS)
    options: CohorlyModuleOptions,
  ) {
    const { token, isGlobal: _isGlobal, ...config } = options;
    this.client = new CohorlyNode(token, config);
  }

  /** Profile operations (people.set / set_once / increment / unset / delete_user). */
  get people(): CohorlyPeople {
    return this.client.people;
  }

  track(
    event: string,
    properties: Properties & { distinct_id: string },
    callback?: Callback,
  ): Promise<void> {
    return this.client.track(event, properties, callback);
  }

  trackBatch(events: BatchEventInput[], callback?: Callback): Promise<void> {
    return this.client.trackBatch(events, callback);
  }

  /** Track a historical event with an explicit timestamp. */
  import(
    event: string,
    time: Date | number,
    properties: Properties & { distinct_id: string },
    callback?: Callback,
  ): Promise<void> {
    return this.client.import(event, time, properties, callback);
  }

  importBatch(events: BatchEventInput[], callback?: Callback): Promise<void> {
    return this.client.importBatch(events, callback);
  }

  alias(distinctId: string, alias: string, callback?: Callback): Promise<void> {
    return this.client.alias(distinctId, alias, callback);
  }

  flush(callback?: Callback): Promise<void> {
    return this.client.flush(callback);
  }

  /** Final flush + timer stop when the Nest application shuts down. */
  async onApplicationShutdown(): Promise<void> {
    await this.client.shutdown();
  }
}
