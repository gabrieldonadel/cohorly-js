import type {
  Callback,
  CohorlyPeople,
  EngagePayload,
  Properties,
} from "./types.js";

type SendEngage = (
  payload: EngagePayload,
  callback?: Callback,
) => Promise<void>;

/**
 * Builds the mixpanel-node-style `people` API on top of a raw /engage sender.
 * Snake_case names mirror mixpanel-node (`set_once`, `delete_user`);
 * camelCase aliases are provided for idiomatic TypeScript.
 */
export function createPeople(sendEngage: SendEngage): CohorlyPeople {
  function normalizeProps(
    propsOrKey: Properties | string,
    valueOrCb: unknown,
    cb: Callback | undefined,
  ): { props: Properties; callback: Callback | undefined } {
    if (typeof propsOrKey === "string") {
      return { props: { [propsOrKey]: valueOrCb }, callback: cb };
    }
    return {
      props: propsOrKey,
      callback: typeof valueOrCb === "function" ? (valueOrCb as Callback) : cb,
    };
  }

  const set = (
    distinctId: string,
    propsOrKey: Properties | string,
    valueOrCb?: unknown,
    cb?: Callback,
  ): Promise<void> => {
    const { props, callback } = normalizeProps(propsOrKey, valueOrCb, cb);
    return sendEngage({ distinct_id: distinctId, $set: props }, callback);
  };

  const setOnce = (
    distinctId: string,
    propsOrKey: Properties | string,
    valueOrCb?: unknown,
    cb?: Callback,
  ): Promise<void> => {
    const { props, callback } = normalizeProps(propsOrKey, valueOrCb, cb);
    return sendEngage({ distinct_id: distinctId, $set_once: props }, callback);
  };

  const increment = (
    distinctId: string,
    propOrObject: Record<string, number> | string,
    byOrCb?: number | Callback,
    cb?: Callback,
  ): Promise<void> => {
    let add: Record<string, number>;
    let callback = cb;
    if (typeof propOrObject === "string") {
      let by = 1;
      if (typeof byOrCb === "number") by = byOrCb;
      else if (typeof byOrCb === "function") callback = byOrCb;
      add = { [propOrObject]: by };
    } else {
      add = propOrObject;
      if (typeof byOrCb === "function") callback = byOrCb;
    }
    return sendEngage({ distinct_id: distinctId, $add: add }, callback);
  };

  const unset = (
    distinctId: string,
    properties: string | string[],
    callback?: Callback,
  ): Promise<void> => {
    const keys = Array.isArray(properties) ? properties : [properties];
    return sendEngage({ distinct_id: distinctId, $unset: keys }, callback);
  };

  const deleteUser = (distinctId: string, callback?: Callback): Promise<void> =>
    sendEngage({ distinct_id: distinctId, $delete: true }, callback);

  return {
    set,
    set_once: setOnce,
    setOnce,
    increment,
    unset,
    delete_user: deleteUser,
    deleteUser,
  };
}
