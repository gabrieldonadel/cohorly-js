"use client";

import { createContext, useContext, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { init } from "@cohorly/web";
import type { Cohorly, CohorlyWebOptions } from "@cohorly/web";

const CohorlyContext = createContext<Cohorly | null>(null);

export interface CohorlyProviderProps extends CohorlyWebOptions {
  children?: ReactNode;
}

/** Initializes the Cohorly web SDK on mount and exposes the client via useCohorly(). */
export function CohorlyProvider({ children, ...options }: CohorlyProviderProps) {
  const clientRef = useRef<Cohorly | null>(null);
  if (!clientRef.current) {
    clientRef.current = init(options);
  }

  useEffect(() => {
    // init() already ran during render (above); this effect exists so the
    // provider behaves predictably under React StrictMode's double-invoke
    // and so future teardown logic has a natural home.
  }, []);

  return (
    <CohorlyContext.Provider value={clientRef.current}>
      {children}
    </CohorlyContext.Provider>
  );
}

/** Access the Cohorly client from within a <CohorlyProvider>. */
export function useCohorly(): Cohorly {
  const client = useContext(CohorlyContext);
  if (!client) {
    throw new Error("useCohorly() must be used within a <CohorlyProvider>");
  }
  return client;
}
