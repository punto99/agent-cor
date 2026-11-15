import {
  convexAuthNextjsMiddleware,
  createRouteMatcher,
} from "@convex-dev/auth/nextjs/server";
import { NextResponse } from "next/server";

const isLoginPage = createRouteMatcher(["/login", "/login/internal"]);
const isProtectedRoute = createRouteMatcher(["/", "/workspace(.*)"]);

export default convexAuthNextjsMiddleware(async (request, { convexAuth }) => {
  // Si el usuario está autenticado y trata de ir al login, redirigir a workspace
  if (isLoginPage(request) && (await convexAuth.isAuthenticated())) {
    const taskId = request.nextUrl.searchParams.get("taskId");
    const taskPath = request.nextUrl.pathname === "/login/internal"
      ? "/workspace/control-panel"
      : "/workspace/requests";
    return NextResponse.redirect(new URL(
      taskId ? `${taskPath}?taskId=${encodeURIComponent(taskId)}` : "/workspace",
      request.url,
    ));
  }
  // Si el usuario no está autenticado y trata de ir a ruta protegida, redirigir a login
  if (isProtectedRoute(request) && !(await convexAuth.isAuthenticated())) {
    const internalTaskId = request.nextUrl.pathname === "/workspace/control-panel" ? request.nextUrl.searchParams.get("taskId") : null;
    if (internalTaskId) {
      return NextResponse.redirect(new URL(
        `/login/internal?taskId=${encodeURIComponent(internalTaskId)}`,
        request.url,
      ));
    }
    const taskId = request.nextUrl.pathname === "/workspace/requests" ? request.nextUrl.searchParams.get("taskId") : null;
    return NextResponse.redirect(new URL(
      taskId ? `/login?taskId=${encodeURIComponent(taskId)}` : "/login",
      request.url,
    ));
  }
});

export const config = {
  matcher: ["/((?!.*\\..*|_next).*)", "/", "/(api|trpc)(.*)"],
};
