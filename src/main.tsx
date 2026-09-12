// SPDX-License-Identifier: Apache-2.0
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./ui/App";
import { installErrorLogging } from "./ipc/client";

installErrorLogging();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
