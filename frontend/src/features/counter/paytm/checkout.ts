import type { Schemas } from "../../../lib/api/client";

/**
 * Paytm's JS Checkout, as documented at paytmpayments.com/docs/jscheckout-invoke-payment:
 * load `{HOST}/merchantpgpui/checkoutjs/merchants/{MID}.js`, then onLoad -> init(config) -> invoke().
 * The host, MID, order id, amount and txnToken all come from the backend; the merchant key never
 * reaches this code. `redirect: false` keeps the customer on the Counter page, and Paytm then reports
 * through the transactionStatus handler. What it reports is not used: it only prompts the backend
 * to ask Paytm itself (POST /payments/paytm/{id}/verify).
 */

type CheckoutJS = {
  onLoad(callback: () => void): void;
  init(config: unknown): Promise<unknown>;
  invoke(): void;
  /** Not in Paytm's documentation; used only when the loaded script provides it. */
  close?: () => void;
};

type PaytmWindow = Window & { Paytm?: { CheckoutJS?: CheckoutJS } };

export type CheckoutHandlers = {
  /** Paytm's page finished one way or another: time to ask the backend what really happened. */
  onResult: () => void;
  /** The checkout could not be shown. No money moved because of this. */
  onError: (message: string) => void;
};

export const checkoutScriptUrl = (checkout: Schemas["PaytmCheckout"]) =>
  `${checkout.host}/merchantpgpui/checkoutjs/merchants/${checkout.mid}.js`;

export const CHECKOUT_UNAVAILABLE =
  "Paytm's payment page could not be opened. Check the internet connection, then continue the payment.";

function loadScript(src: string): Promise<void> {
  const existing = document.querySelector<HTMLScriptElement>(`script[data-paytm-checkout="${src}"]`);
  if (existing && (window as PaytmWindow).Paytm?.CheckoutJS) return Promise.resolve();
  existing?.remove();
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.type = "application/javascript";
    script.src = src;
    script.crossOrigin = "anonymous";
    script.dataset.paytmCheckout = src;
    script.onload = () => resolve();
    script.onerror = () => {
      script.remove();
      reject(new Error(CHECKOUT_UNAVAILABLE));
    };
    document.head.appendChild(script);
  });
}

/** Shows Paytm's payment page for this order. Resolves once it has been asked to open. */
export async function openPaytmCheckout(checkout: Schemas["PaytmCheckout"], handlers: CheckoutHandlers): Promise<void> {
  await loadScript(checkoutScriptUrl(checkout));
  const js = (window as PaytmWindow).Paytm?.CheckoutJS;
  if (!js) throw new Error(CHECKOUT_UNAVAILABLE);
  const config = {
    root: "",
    flow: "DEFAULT",
    data: { orderId: checkout.order_id, token: checkout.txn_token, tokenType: "TXN_TOKEN", amount: checkout.amount },
    merchant: { redirect: false },
    handler: {
      transactionStatus: () => {
        js.close?.();
        handlers.onResult();
      },
      notifyMerchant: () => {}, // required by Paytm; the Counter keeps its own "check status" and "cancel" controls
    },
  };
  js.onLoad(() => {
    js.init(config)
      .then(() => js.invoke())
      .catch(() => handlers.onError(CHECKOUT_UNAVAILABLE));
  });
}
