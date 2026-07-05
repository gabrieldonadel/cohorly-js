import "reflect-metadata";
import { Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CohorlyModule, CohorlyService } from "../src/index.js";

const { FakeClient, instances } = vi.hoisted(() => {
  const instances: FakeClient[] = [];
  class FakeClient {
    token: string;
    config: Record<string, unknown>;
    people = { set: vi.fn().mockResolvedValue(undefined) };
    track = vi.fn().mockResolvedValue(undefined);
    trackBatch = vi.fn().mockResolvedValue(undefined);
    import = vi.fn().mockResolvedValue(undefined);
    importBatch = vi.fn().mockResolvedValue(undefined);
    alias = vi.fn().mockResolvedValue(undefined);
    flush = vi.fn().mockResolvedValue(undefined);
    shutdown = vi.fn().mockResolvedValue(undefined);
    constructor(token: string, config: Record<string, unknown>) {
      this.token = token;
      this.config = config;
      instances.push(this);
    }
  }
  return { FakeClient, instances };
});

vi.mock("@cohorly/node", () => ({ CohorlyNode: FakeClient }));

beforeEach(() => {
  instances.length = 0;
});

describe("CohorlyModule.forRoot", () => {
  it("provides a CohorlyService wired with the options", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        CohorlyModule.forRoot({
          token: "tok-1",
          host: "http://analytics:4000",
          flushIntervalMs: 0,
        }),
      ],
    }).compile();

    const service = moduleRef.get(CohorlyService);
    expect(instances).toHaveLength(1);
    expect(service.client).toBe(instances[0]);
    expect(instances[0].token).toBe("tok-1");
    // token/isGlobal are stripped; the rest is passed through as config.
    expect(instances[0].config).toEqual({
      host: "http://analytics:4000",
      flushIntervalMs: 0,
    });

    await service.track("signup", { distinct_id: "u1", plan: "pro" });
    expect(instances[0].track).toHaveBeenCalledWith(
      "signup",
      { distinct_id: "u1", plan: "pro" },
      undefined,
    );

    await service.people.set("u1", { plan: "pro" });
    expect(instances[0].people.set).toHaveBeenCalledWith("u1", { plan: "pro" });

    await service.alias("u1", "anon-1");
    expect(instances[0].alias).toHaveBeenCalledWith("u1", "anon-1", undefined);

    await service.flush();
    expect(instances[0].flush).toHaveBeenCalled();

    await moduleRef.close();
  });

  it("marks the module global when isGlobal is set", () => {
    expect(CohorlyModule.forRoot({ token: "t" }).global).toBe(false);
    expect(CohorlyModule.forRoot({ token: "t", isGlobal: true }).global).toBe(
      true,
    );
    expect(
      CohorlyModule.forRootAsync({
        useFactory: () => ({ token: "t" }),
        isGlobal: true,
      }).global,
    ).toBe(true);
  });

  it("shuts the client down (final flush) on application shutdown", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [CohorlyModule.forRoot({ token: "tok" })],
    }).compile();

    const service = moduleRef.get(CohorlyService);
    expect(instances[0].shutdown).not.toHaveBeenCalled();

    await moduleRef.close(); // triggers onApplicationShutdown
    expect(instances[0].shutdown).toHaveBeenCalledTimes(1);
    expect(service.client).toBe(instances[0]);
  });
});

describe("CohorlyModule.forRootAsync", () => {
  it("resolves options via useFactory with injected dependencies", async () => {
    @Module({
      providers: [{ provide: "COHORLY_HOST", useValue: "http://cfg:4000" }],
      exports: ["COHORLY_HOST"],
    })
    class ConfigLikeModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [
        CohorlyModule.forRootAsync({
          imports: [ConfigLikeModule],
          inject: ["COHORLY_HOST"],
          useFactory: async (host: string) => ({
            token: "async-tok",
            host,
            batchSize: 50,
          }),
        }),
      ],
    }).compile();

    const service = moduleRef.get(CohorlyService);
    expect(service.client).toBe(instances[0]);
    expect(instances[0].token).toBe("async-tok");
    expect(instances[0].config).toEqual({
      host: "http://cfg:4000",
      batchSize: 50,
    });
    await moduleRef.close();
  });
});
