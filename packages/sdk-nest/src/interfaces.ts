import type { FactoryProvider, ModuleMetadata } from "@nestjs/common";
import type { CohorlyConfig } from "@cohorly/node";

/** Options for CohorlyModule.forRoot(): the @cohorly/node config + token. */
export interface CohorlyModuleOptions extends CohorlyConfig {
  /** Cohorly project token (ingestion auth). Required. */
  token: string;
  /** Register the module globally so CohorlyService is injectable anywhere
   * without importing CohorlyModule again. Default false. */
  isGlobal?: boolean;
}

/** Options for CohorlyModule.forRootAsync(). */
export interface CohorlyModuleAsyncOptions
  extends Pick<ModuleMetadata, "imports"> {
  /** Factory returning the module options (sync or async). */
  useFactory: (
    // biome-ignore lint/suspicious/noExplicitAny: mirrors NestJS FactoryProvider - injected deps are of arbitrary types.
    ...args: any[]
  ) =>
    | Promise<Omit<CohorlyModuleOptions, "isGlobal">>
    | Omit<CohorlyModuleOptions, "isGlobal">;
  /** Providers to inject into `useFactory`. */
  inject?: FactoryProvider["inject"];
  /** Register the module globally. Default false. */
  isGlobal?: boolean;
}
