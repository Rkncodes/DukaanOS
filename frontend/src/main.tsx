import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router/dom";
import { Providers } from "./app/providers";
import "./i18n"; // the saved language is read here, before anything renders
import { router } from "./app/router";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Providers>
      <RouterProvider router={router} />
    </Providers>
  </StrictMode>,
);
