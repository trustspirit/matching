import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router-dom";
import { Login } from "./routes/Login";
import { Result } from "./routes/Result";
import "./design/tokens.css";

const router = createBrowserRouter([
  { path: "/", element: <Login /> },
  { path: "/result", element: <Result /> },
  { path: "*", element: <Navigate to="/" replace /> },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
