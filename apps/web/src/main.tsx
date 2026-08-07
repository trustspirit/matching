import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import "./design/tokens.css";

const router = createBrowserRouter([
  { path: "/", element: <div className="type-display-lg">랜덤 소개팅</div> },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
