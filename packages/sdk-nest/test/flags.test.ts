import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CohorlyModule, CohorlyService } from "../src/index.js";

const { FakeClient, instances } = vi.hoisted(() => {
  const instances: FakeClient[] = [];
  class FakeClient {
    flags = {
      isFeatureEnabled: vi.fn().mockResolvedValue(true),
      getFeatureFlag: vi.fn().mockResolvedValue("blue"),
      getFeatureFlagPayload: vi.fn().mockResolvedValue({ color: "#00f" }),
      getAllFlags: vi.fn().mockResolvedValue({
        banner: { enabled: true, variant: "blue", payload: null, reason: "rule:0" },
      }),
    };
    shutdown = vi.fn().mockResolvedValue(undefined);
    constructor(
      public token: string,
      public config: Record<string, unknown>,
    ) {
      instances.push(this);
    }
  }
  return { FakeClient, instances };
});

vi.mock("@cohorly/node", () => ({ CohorlyNode: FakeClient }));

async function makeService(): Promise<CohorlyService> {
  const moduleRef = await Test.createTestingModule({
    imports: [CohorlyModule.forRoot({ token: "tok" })],
  }).compile();
  return moduleRef.get(CohorlyService);
}

beforeEach(() => {
  instances.length = 0;
});

describe("CohorlyService feature flags", () => {
  it("exposes the underlying client's flags API", async () => {
    const service = await makeService();
    expect(service.flags).toBe(instances[0].flags);
  });

  it("delegates each flag method to the node client", async () => {
    const service = await makeService();

    await expect(service.isFeatureEnabled("checkout", "u1")).resolves.toBe(true);
    expect(instances[0].flags.isFeatureEnabled).toHaveBeenCalledWith(
      "checkout",
      "u1",
      undefined,
    );

    await expect(service.getFeatureFlag("banner", "u1")).resolves.toBe("blue");
    expect(instances[0].flags.getFeatureFlag).toHaveBeenCalledWith(
      "banner",
      "u1",
      undefined,
    );

    await expect(service.getFeatureFlagPayload("banner", "u1")).resolves.toEqual({
      color: "#00f",
    });
    expect(instances[0].flags.getFeatureFlagPayload).toHaveBeenCalledWith(
      "banner",
      "u1",
      undefined,
    );

    await expect(service.getAllFlags("u1")).resolves.toEqual({
      banner: { enabled: true, variant: "blue", payload: null, reason: "rule:0" },
    });
    expect(instances[0].flags.getAllFlags).toHaveBeenCalledWith("u1");
  });

  it("passes per-call options through (exposure events)", async () => {
    const service = await makeService();
    await service.isFeatureEnabled("checkout", "u1", { sendExposureEvent: true });
    expect(instances[0].flags.isFeatureEnabled).toHaveBeenCalledWith(
      "checkout",
      "u1",
      { sendExposureEvent: true },
    );
  });

  it("passes flagSecret / flagPollIntervalMs into the node client config", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        CohorlyModule.forRoot({
          token: "tok",
          flagSecret: "fs_secret",
          flagPollIntervalMs: 1000,
        }),
      ],
    }).compile();
    moduleRef.get(CohorlyService);
    expect(instances[0].config).toMatchObject({
      flagSecret: "fs_secret",
      flagPollIntervalMs: 1000,
    });
  });

  it("shutdown stops the client (and with it the definitions poller)", async () => {
    const service = await makeService();
    await service.onApplicationShutdown();
    expect(instances[0].shutdown).toHaveBeenCalledTimes(1);
  });
});
