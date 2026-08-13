import { describe, expect, it } from "vitest";
import {
  invalidateConnectorCache,
  subscribeConnectorCache,
} from "./connectorCache";

describe("connectorCache invalidation bus", () => {
  it("notifies every subscriber on invalidate", () => {
    let a = 0;
    let b = 0;
    const offA = subscribeConnectorCache(() => a++);
    const offB = subscribeConnectorCache(() => b++);

    invalidateConnectorCache();
    expect(a).toBe(1);
    expect(b).toBe(1);

    invalidateConnectorCache();
    expect(a).toBe(2);
    expect(b).toBe(2);

    offA();
    offB();
  });

  it("stops notifying after unsubscribe", () => {
    let calls = 0;
    const off = subscribeConnectorCache(() => calls++);
    invalidateConnectorCache();
    off();
    invalidateConnectorCache();
    expect(calls).toBe(1);
  });

  it("unsubscribing is idempotent and scoped to its own listener", () => {
    let a = 0;
    let b = 0;
    const offA = subscribeConnectorCache(() => a++);
    const offB = subscribeConnectorCache(() => b++);
    offA();
    offA(); // double-unsubscribe must be harmless
    invalidateConnectorCache();
    expect(a).toBe(0);
    expect(b).toBe(1);
    offB();
  });

  it("survives a listener unsubscribing itself mid-broadcast", () => {
    // A hook unmounting in reaction to the broadcast removes its listener
    // while the set is being iterated — the snapshot copy keeps the rest
    // of the broadcast intact.
    let later = 0;
    const offSelf: Array<() => void> = [];
    offSelf.push(
      subscribeConnectorCache(() => {
        offSelf[0]();
      }),
    );
    const offLater = subscribeConnectorCache(() => later++);

    expect(() => invalidateConnectorCache()).not.toThrow();
    expect(later).toBe(1);
    offLater();
  });
});
