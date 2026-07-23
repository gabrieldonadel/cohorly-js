import { describe, expect, it, vi } from "vitest";
import { deriveDeviceInfo, fetchNativeDeviceInfo, mergePlatformInfo, watchWifi } from "../src/deviceInfo.js";

function iosRn() {
  return { Platform: { OS: "ios", Version: "17.0" }, Dimensions: { get: () => ({ height: 844, width: 390 }) } };
}

function androidRn() {
  return { Platform: { OS: "android", Version: 34 }, Dimensions: { get: () => ({ height: 800, width: 360 }) } };
}

describe("deriveDeviceInfo", () => {
  it("derives app version/build/model/manufacturer/brand/carrier from react-native-device-info on iOS", () => {
    const rnDeviceInfo = {
      getVersion: () => "1.2.3",
      getBuildNumber: () => "42",
      getDeviceId: () => "iPhone15,2",
      getManufacturerSync: () => "should not be used on ios",
      getBrand: () => "Apple",
      getCarrierSync: () => "Vivo",
    };
    const result = deriveDeviceInfo({ rn: iosRn(), rnDeviceInfo });

    expect(result.appVersion).toBe("1.2.3");
    expect(result.appBuild).toBe("42");
    expect(result.platformInfo.os).toBe("iOS");
    expect(result.platformInfo.osVersion).toBe("17.0");
    expect(result.platformInfo.screenHeight).toBe(844);
    expect(result.platformInfo.screenWidth).toBe(390);
    expect(result.platformInfo.model).toBe("iPhone15,2");
    expect(result.platformInfo.manufacturer).toBe("Apple");
    expect(result.platformInfo.carrier).toBe("Vivo");
  });

  it("derives model/manufacturer from react-native-device-info on Android", () => {
    const rnDeviceInfo = {
      getVersion: () => "2.0.0",
      getBuildNumber: () => "7",
      getModel: () => "Pixel 8",
      getManufacturerSync: () => "Google",
      getBrand: () => "google",
      getCarrierSync: () => "",
    };
    const result = deriveDeviceInfo({ rn: androidRn(), rnDeviceInfo });

    expect(result.platformInfo.os).toBe("Android");
    expect(result.platformInfo.model).toBe("Pixel 8");
    expect(result.platformInfo.manufacturer).toBe("Google");
    expect(result.platformInfo.brand).toBe("google");
    expect(result.platformInfo.carrier).toBeUndefined(); // empty string omitted
  });

  it("falls back to expo-application/expo-device when react-native-device-info is absent", () => {
    const expoApplication = { nativeApplicationVersion: "3.1.0", nativeBuildVersion: "9" };
    const expoDevice = { modelId: "iPhone15,3", modelName: "iPhone 15 Pro", manufacturer: "Apple", brand: "Apple" };
    const result = deriveDeviceInfo({ rn: iosRn(), expoApplication, expoDevice });

    expect(result.appVersion).toBe("3.1.0");
    expect(result.appBuild).toBe("9");
    expect(result.platformInfo.model).toBe("iPhone15,3");
  });

  it("prefers react-native-device-info over expo when both are present", () => {
    const rnDeviceInfo = { getVersion: () => "1.0.0", getBuildNumber: () => "1", getDeviceId: () => "rn-di-model" };
    const expoApplication = { nativeApplicationVersion: "9.9.9", nativeBuildVersion: "99" };
    const expoDevice = { modelId: "expo-model" };
    const result = deriveDeviceInfo({ rn: iosRn(), rnDeviceInfo, expoApplication, expoDevice });

    expect(result.appVersion).toBe("1.0.0");
    expect(result.platformInfo.model).toBe("rn-di-model");
  });

  it("returns an empty-ish result when no modules are present, never throws", () => {
    const result = deriveDeviceInfo({});
    expect(result.appVersion).toBeUndefined();
    expect(result.appBuild).toBeUndefined();
    expect(result.platformInfo.os).toBeUndefined();
    expect(result.platformInfo.model).toBeUndefined();
  });

  it("omits fields whose getters throw, never propagates the error", () => {
    const rnDeviceInfo = {
      getVersion: () => {
        throw new Error("bridge not linked");
      },
      getCarrierSync: () => {
        throw new Error("no permission");
      },
    };
    const result = deriveDeviceInfo({ rn: iosRn(), rnDeviceInfo });
    expect(result.appVersion).toBeUndefined();
    expect(result.platformInfo.carrier).toBeUndefined();
    expect(result.platformInfo.os).toBe("iOS"); // unaffected fields still derive
  });
});

describe("mergePlatformInfo", () => {
  it("lets defined injected fields win over derived ones", () => {
    const derived = { os: "iOS", model: "derived-model", manufacturer: "Apple" };
    const merged = mergePlatformInfo(derived, { model: "explicit-model" });
    expect(merged.model).toBe("explicit-model");
    expect(merged.os).toBe("iOS");
    expect(merged.manufacturer).toBe("Apple");
  });

  it("returns derived untouched when nothing is injected", () => {
    const derived = { os: "Android", model: "Pixel 8" };
    expect(mergePlatformInfo(derived, undefined)).toEqual(derived);
  });

  it("does not let an undefined injected field clobber a derived value", () => {
    const derived = { os: "iOS", carrier: "Vivo" };
    const merged = mergePlatformInfo(derived, { os: undefined, carrier: undefined });
    expect(merged.os).toBe("iOS");
    expect(merged.carrier).toBe("Vivo");
  });
});

describe("fetchNativeDeviceInfo", () => {
  it("reads from the CohorlyReactNative bridge module when linked", async () => {
    const rn = {
      NativeModules: {
        CohorlyReactNative: {
          getDeviceInfo: () =>
            Promise.resolve({
              appVersion: "1.5.0",
              appBuild: "10",
              model: "iPhone15,2",
              manufacturer: "Apple",
              carrier: "Vivo",
            }),
        },
      },
    };
    const result = await fetchNativeDeviceInfo(rn);
    expect(result.appVersion).toBe("1.5.0");
    expect(result.appBuild).toBe("10");
    expect(result.platformInfo.model).toBe("iPhone15,2");
    expect(result.platformInfo.manufacturer).toBe("Apple");
    expect(result.platformInfo.carrier).toBe("Vivo");
  });

  it("resolves an empty result when the native module isn't linked", async () => {
    const result = await fetchNativeDeviceInfo(undefined);
    expect(result.appVersion).toBeUndefined();
    expect(result.platformInfo).toEqual({});
  });

  it("resolves an empty result, never rejects, when the native call throws", async () => {
    const rn = {
      NativeModules: {
        CohorlyReactNative: {
          getDeviceInfo: () => Promise.reject(new Error("bridge error")),
        },
      },
    };
    await expect(fetchNativeDeviceInfo(rn)).resolves.toEqual({ platformInfo: {} });
  });
});

describe("watchWifi", () => {
  it("fires onChange from the initial fetch() and from the listener", async () => {
    let listener: ((state: { type?: string }) => void) | undefined;
    const netInfo = {
      fetch: () => Promise.resolve({ type: "wifi" }),
      addEventListener: (cb: (state: { type?: string }) => void) => {
        listener = cb;
      },
    };
    const onChange = vi.fn();
    watchWifi(netInfo, onChange);
    await Promise.resolve();
    await Promise.resolve();
    expect(onChange).toHaveBeenCalledWith(true);

    listener?.({ type: "cellular" });
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("never throws when netInfo is absent or broken", () => {
    expect(() => watchWifi(undefined, () => {})).not.toThrow();
    expect(() =>
      watchWifi(
        {
          fetch: () => {
            throw new Error("boom");
          },
        },
        () => {},
      ),
    ).not.toThrow();
  });
});
