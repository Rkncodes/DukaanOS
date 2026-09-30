import { useState, type FormEvent } from "react";
import { useLogin, useRegister } from "./session";

const input = "w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none";

export function AuthPage() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const login = useLogin();
  const register = useRegister();
  const active = mode === "login" ? login : register;

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const email = String(f.get("email"));
    const password = String(f.get("password"));
    if (mode === "login") {
      login.mutate({ email, password });
    } else {
      register.mutate({ email, password, name: String(f.get("name")), store_name: String(f.get("store_name")) });
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
      <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-bold text-emerald-700">DukaanOS</h1>
        <p className="mb-6 text-sm text-slate-500">
          {mode === "login" ? "Log in to your dukaan" : "Register your dukaan"}
        </p>

        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          {mode === "register" && (
            <>
              <input name="name" placeholder="Your name" required className={input} />
              <input name="store_name" placeholder="Store name" required className={input} />
            </>
          )}
          <input
            name="email"
            type="email"
            placeholder="Email"
            required
            defaultValue={mode === "login" ? "ramesh@dukaanos.dev" : ""}
            className={input}
          />
          <input
            name="password"
            type="password"
            placeholder="Password"
            required
            minLength={mode === "register" ? 8 : undefined}
            defaultValue={mode === "login" ? "demo1234" : ""}
            className={input}
          />
          {active.error && <p className="text-sm text-red-600">{active.error.message}</p>}
          <button
            type="submit"
            disabled={active.isPending}
            className="rounded-md bg-emerald-600 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
          >
            {active.isPending ? "Please wait…" : mode === "login" ? "Log in" : "Create account"}
          </button>
        </form>

        <button
          type="button"
          onClick={() => setMode(mode === "login" ? "register" : "login")}
          className="mt-4 text-sm text-emerald-700 hover:underline"
        >
          {mode === "login" ? "New here? Register your store" : "Already registered? Log in"}
        </button>
        {mode === "login" && <p className="mt-4 text-xs text-slate-400">Demo: ramesh@dukaanos.dev / demo1234</p>}
      </div>
    </div>
  );
}
