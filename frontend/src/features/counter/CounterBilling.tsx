import { useLocation, useNavigate } from "react-router";
import { CounterPage, type CounterMode } from "./CounterPage";

/** Where each way of adding items lives. /counter itself is manual billing: the search box and product grid. */
export const COUNTER_MODE_PATHS: Record<CounterMode, string> = {
  live: "/counter/vision",
  barcode: "/counter/barcode",
  photo: "/counter/photo",
  parchi: "/counter/parchi",
  voice: "/counter/voice",
};

/**
 * The Counter under the app's navigation. It is the one existing Counter page: the URL only says which
 * input is open. All of these routes share this element, so moving between them keeps the bill on screen.
 */
export function CounterBilling() {
  const pathname = useLocation().pathname.replace(/\/+$/, "");
  const navigate = useNavigate();
  const mode = (Object.keys(COUNTER_MODE_PATHS) as CounterMode[]).find((m) => COUNTER_MODE_PATHS[m] === pathname) ?? null;
  return <CounterPage mode={mode} onModeChange={(next) => navigate(next ? COUNTER_MODE_PATHS[next] : "/counter")} />;
}
