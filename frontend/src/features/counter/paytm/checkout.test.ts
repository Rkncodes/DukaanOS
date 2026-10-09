// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Schemas } from "../../../lib/api/client";
import { CHECKOUT_UNAVAILABLE, openPaytmCheckout } from "./checkout";

const CHECKOUT: Schemas["PaytmCheckout"] = {
  host: "https://securestage.paytmpayments.com",
  mid: "TESTMID0000000000001",
  order_id: "DKNpay1",
  txn_token: "token-1",
  amount: "130.00",
};

type Config = {
  data: unknown;
  merchant: unknown;
  flow: string;
  handler: { transactionStatus: (data: unknown) => void; notifyMerchant: (name: string, data: unknown) => void };
};
type PaytmWindow = { Paytm?: unknown };

/** jsdom does not fetch scripts: stand in for the browser loading (or failing to load) Paytm's script. */
function browserLoadsScript(outcome: "load" | "error", init: (config: Config) => Promise<unknown> = async () => {}) {
  const page = { scripts: [] as HTMLScriptElement[], configs: [] as Config[], invoked: 0, closed: 0 };
  vi.spyOn(document.head, "appendChild").mockImplementation((node) => {
    const script = node as HTMLScriptElement;
    page.scripts.push(script);
    queueMicrotask(() => {
      if (outcome === "error") return script.onerror?.(new Event("error"));
      (window as PaytmWindow).Paytm = {
        CheckoutJS: {
          onLoad: (ready: () => void) => ready(),
          init: (config: Config) => (page.configs.push(config), init(config)),
          invoke: () => page.invoked++,
          close: () => page.closed++,
        },
      };
      script.onload?.(new Event("load"));
    });
    return node;
  });
  return page;
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as PaytmWindow).Paytm;
});

describe("Paytm JS Checkout", () => {
  it("loads Paytm's script and initialises the checkout with the backend's order, token and amount", async () => {
    const page = browserLoadsScript("load");
    const onResult = vi.fn();
    await openPaytmCheckout(CHECKOUT, { onResult, onError: vi.fn() });
    await Promise.resolve();

    expect(page.scripts.map((s) => [s.src, s.crossOrigin])).toEqual([
      ["https://securestage.paytmpayments.com/merchantpgpui/checkoutjs/merchants/TESTMID0000000000001.js", "anonymous"],
    ]);
    const [config] = page.configs;
    expect(config.flow).toBe("DEFAULT");
    expect(config.data).toEqual({ orderId: "DKNpay1", token: "token-1", tokenType: "TXN_TOKEN", amount: "130.00" });
    expect(config.merchant).toEqual({ redirect: false }); // stay on the Counter page
    expect(page.invoked).toBe(1);
    expect(onResult).not.toHaveBeenCalled();

    // Whatever Paytm's page says happened is not passed on: it only prompts a check with the backend.
    config.handler.transactionStatus({ STATUS: "TXN_SUCCESS", TXNAMOUNT: "130.00" });
    expect(onResult).toHaveBeenCalledExactlyOnceWith();
    expect(page.closed).toBe(1);
    config.handler.notifyMerchant("SOME_EVENT", {});
    expect(onResult).toHaveBeenCalledTimes(1);
  });

  it("reports when Paytm's page cannot be loaded or initialised", async () => {
    browserLoadsScript("error");
    await expect(openPaytmCheckout(CHECKOUT, { onResult: vi.fn(), onError: vi.fn() })).rejects.toThrow(CHECKOUT_UNAVAILABLE);
    vi.restoreAllMocks();

    const page = browserLoadsScript("load", () => Promise.reject(new Error("invalid token")));
    const onError = vi.fn();
    await openPaytmCheckout(CHECKOUT, { onResult: vi.fn(), onError });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(CHECKOUT_UNAVAILABLE));
    expect(page.invoked).toBe(0);
  });
});
