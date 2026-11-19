import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// Le launcher n'a pas de navigation web : le clic droit reste au jeu.
document.addEventListener("contextmenu", (event) => event.preventDefault());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
