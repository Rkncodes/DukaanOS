// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SalaahkaarPanel } from "./SalaahkaarPanel";

/**
 * The Salaahkaar panel against an in-memory stand-in for the backend's assistant endpoints. The stand-in
 * plays the part of backend + model: the panel must send the question as written, show what comes back
 * as written, and never show an answer that did not come from the backend.
 */

const server = vi.hoisted(() => ({
  handle: async (_req: Request): Promise<Response> => new Response(null, { status: 500 }),
}));

vi.mock("../../lib/api/client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/api/client")>();
  return { ...mod, api: mod.createApi("http://test", (req) => server.handle(req as Request)) };
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const refuse = (status: number, code: string, message: string) => json({ error: { code, message, details: null } }, status);

type Ask = { question: string; history: { role: string; content: string }[] };

let available: boolean;
let asked: Ask[];
/** What the "backend" answers to the next question. A promise holds the answer back to show the loading state. */
let answer: (ask: Ask) => Response | Promise<Response>;

beforeEach(() => {
  available = true;
  asked = [];
  answer = () => json({ answer: "Aaj aapki total bikri ₹2,450 hui hai.", tools_used: ["get_today_sales"] });
  server.handle = async (req) => {
    const route = `${req.method} ${new URL(req.url).pathname}`;
    if (route === "GET /api/v1/auth/me")
      return json({ user: { name: "Ramesh Kumar" }, merchant: { store_name: "Ramesh General Store", store_slug: "ramesh" } });
    if (route === "GET /api/v1/assistant/status")
      return json({
        available,
        reason: available ? null : "Salaahkaar is not set up yet: add GROQ_API_KEY to backend/.env and restart the backend.",
        capabilities: [],
      });
    if (route === "POST /api/v1/assistant/ask") {
      const body = (await req.clone().json()) as Ask;
      asked.push(body);
      return answer(body);
    }
    return refuse(404, "not_found", `No fake for ${route}`);
  };
});

afterEach(cleanup);

async function openPanel() {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <SalaahkaarPanel open onClose={onClose} />
    </QueryClientProvider>,
  );
  const panel = within(await screen.findByRole("dialog", { name: "Salaahkaar" }));
  await panel.findByRole("list", { name: "Example questions" });
  await waitFor(() => expect(panel.queryByText("Checking Salaahkaar…")).toBeNull());
  return { user, panel, onClose };
}

const box = (panel: ReturnType<typeof within>) => panel.getByLabelText("Your question") as HTMLTextAreaElement;
const conversation = (panel: ReturnType<typeof within>) =>
  within(panel.getByRole("list", { name: "Conversation" }))
    .getAllByRole("listitem")
    .map((li) => [...li.querySelectorAll("p")].map((p) => p.textContent));

describe("Salaahkaar panel", () => {
  it("greets the merchant and offers example questions in Hindi, Hinglish and English", async () => {
    const { panel } = await openPanel();
    expect(await panel.findByText(/, Ramesh Kumar!/)).toBeTruthy();
    expect(panel.getByText("नमस्ते")).toBeTruthy();
    expect(panel.getByText("आपकी दुकान का सलाहकार")).toBeTruthy();
    expect(panel.getByText(/I answer only from your shop's own\s+data/)).toBeTruthy();
    expect(panel.queryByRole("status")).toBeNull(); // available: no warning

    const examples = within(panel.getByRole("list", { name: "Example questions" })).getAllByRole("button");
    const texts = examples.map((b) => b.textContent);
    for (const example of [
      "आज कितनी बिक्री हुई?",
      "Aaj kitni bikri hui?",
      "राहुल शर्मा का कितना उधार है?",
      "Rahul Sharma ka kitna udhaar hai?",
      "मैगी का कितना स्टॉक बचा है?",
      "Maggi ka stock kitna hai?",
      "आज कितने ऑर्डर आए?",
    ])
      expect(texts).toContain(example);
    // Devanagari is marked as Hindi, so the browser picks a Devanagari font and reads it correctly.
    expect(examples.find((b) => b.textContent === "आज कितनी बिक्री हुई?")!.getAttribute("lang")).toBe("hi");
    expect(examples.find((b) => b.textContent === "Aaj kitni bikri hui?")!.getAttribute("lang")).toBe("en");
  });

  it("asks a typed question, shows a loading state, then the backend's answer and where it was read from", async () => {
    let release = (_: Response) => {};
    answer = () => new Promise<Response>((resolve) => (release = resolve));
    const { user, panel } = await openPanel();

    await user.type(box(panel), "How much did I sell today?");
    await user.click(panel.getByRole("button", { name: "Ask" }));

    const loading = await panel.findByRole("status");
    expect(loading.textContent).toContain("Checking your records…");
    expect(loading.textContent).toContain("आपके रिकॉर्ड देख रहा हूँ…");
    expect(panel.getByText("How much did I sell today?", { selector: "p" })).toBeTruthy(); // the question shows while waiting
    expect((panel.getByRole("button", { name: "Asking…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(panel.queryByRole("list", { name: "Conversation" })).toBeNull(); // no answer exists yet, so none is shown

    release(json({ answer: "You sold ₹2,450 today across 2 sales.", tools_used: ["get_today_sales"] }));
    await panel.findByRole("list", { name: "Conversation" });
    expect(conversation(panel)).toEqual([
      ["How much did I sell today?", "You sold ₹2,450 today across 2 sales.", "From your records: today's sales"],
    ]);
    expect(asked).toEqual([{ question: "How much did I sell today?", history: [] }]);
    expect(box(panel).value).toBe("");
    expect(panel.queryByRole("status")).toBeNull();
    expect(panel.queryByRole("list", { name: "Example questions" })).toBeNull(); // the conversation takes their place
  });

  it("sends a Hindi question exactly as written and shows the Hindi answer exactly as returned", async () => {
    answer = () => json({ answer: "राहुल शर्मा का ₹502 उधार बाकी है।", tools_used: ["get_customer_outstanding"] });
    const { user, panel } = await openPanel();
    await user.type(box(panel), "राहुल शर्मा का कितना उधार है?");
    await user.keyboard("{Enter}"); // Enter asks

    await panel.findByRole("list", { name: "Conversation" });
    expect(asked[0].question).toBe("राहुल शर्मा का कितना उधार है?");
    expect(conversation(panel)).toEqual([["राहुल शर्मा का कितना उधार है?", "राहुल शर्मा का ₹502 उधार बाकी है।", "From your records: khata"]]);
  });

  it("asks a Hinglish example on tap, and sends earlier turns with a follow-up", async () => {
    const { user, panel } = await openPanel();
    await user.click(panel.getByRole("button", { name: "Aaj kitni bikri hui?" }));
    await panel.findByRole("list", { name: "Conversation" });
    expect(asked[0]).toEqual({ question: "Aaj kitni bikri hui?", history: [] });

    answer = () => json({ answer: "Aaj 3 orders aaye.", tools_used: ["get_today_orders"] });
    await user.type(box(panel), "aur orders kitne aaye?{Shift>}{Enter}{/Shift}"); // Shift+Enter is a new line, not Ask
    expect(asked).toHaveLength(1);
    await user.click(panel.getByRole("button", { name: "Ask" }));
    await waitFor(() => expect(conversation(panel)).toHaveLength(2));
    expect(asked[1]).toEqual({
      question: "aur orders kitne aaye?",
      history: [
        { role: "user", content: "Aaj kitni bikri hui?" },
        { role: "assistant", content: "Aaj aapki total bikri ₹2,450 hui hai." },
      ],
    });
    expect(conversation(panel)[1]).toEqual(["aur orders kitne aaye?", "Aaj 3 orders aaye.", "From your records: today's orders"]);

    await user.click(panel.getByRole("button", { name: "Clear" }));
    expect(panel.queryByRole("list", { name: "Conversation" })).toBeNull();
    expect(panel.getByRole("list", { name: "Example questions" })).toBeTruthy();
  });

  it("marks an answer that was not read from the store's records", async () => {
    answer = () => json({ answer: "I don't have access to that information yet.", tools_used: [] });
    const { user, panel } = await openPanel();
    await user.type(box(panel), "What will the weather be tomorrow?{Enter}");
    await panel.findByRole("list", { name: "Conversation" });
    expect(conversation(panel)[0].slice(1)).toEqual(["I don't have access to that information yet.", "Not read from your records"]);
  });

  it("shows the backend's error, keeps the question, and can try again", async () => {
    answer = () => refuse(503, "assistant_unavailable", "Salaahkaar could not answer right now. Groq could not be reached (ConnectTimeout)");
    const { user, panel } = await openPanel();
    await user.type(box(panel), "Maggi ka stock kitna hai?{Enter}");

    const alert = await panel.findByRole("alert");
    expect(alert.textContent).toContain("Salaahkaar could not answer right now. Groq could not be reached (ConnectTimeout)");
    expect(box(panel).value).toBe("Maggi ka stock kitna hai?"); // still there to send again
    expect(panel.queryByRole("list", { name: "Conversation" })).toBeNull(); // an error is never shown as an answer

    answer = () => json({ answer: "Maggi 2-Minute Noodles 70g ka stock 44 hai.", tools_used: ["get_product_stock"] });
    await user.click(panel.getByRole("button", { name: "Ask" }));
    await panel.findByRole("list", { name: "Conversation" });
    expect(conversation(panel)).toEqual([
      ["Maggi ka stock kitna hai?", "Maggi 2-Minute Noodles 70g ka stock 44 hai.", "From your records: stock"],
    ]);
    expect(panel.queryByRole("alert")).toBeNull();
    expect(asked).toHaveLength(2);
  });

  it("says why it is unavailable and sends nothing when no provider is set up", async () => {
    available = false;
    const { user, panel, onClose } = await openPanel();
    expect((await panel.findByRole("status")).textContent).toContain("add GROQ_API_KEY to backend/.env");

    await user.click(panel.getByRole("button", { name: "आज कितनी बिक्री हुई?" }));
    expect(panel.getByRole("alert").textContent).toContain("Your question was not sent.");
    expect(box(panel).value).toBe("आज कितनी बिक्री हुई?");
    await user.clear(box(panel));
    await user.type(box(panel), "Who owes me the most?{Enter}");
    expect(panel.getByRole("alert").textContent).toContain("Your question was not sent.");

    expect(asked).toEqual([]); // nothing reached the backend, and nothing is shown as an answer
    expect(panel.queryByRole("list", { name: "Conversation" })).toBeNull();

    await user.click(panel.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });
});
