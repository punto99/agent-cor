import {
  convexAuthNextjsMiddleware,
  createRouteMatcher,
  nextjsMiddlewareRedirect,
} from "@convex-dev/auth/nextjs/server";

const isLoginPage = createRouteMatcher(["/login"]);
const isProtectedRoute = createRouteMatcher(["/", "/workspace(.*)"]);

export default convexAuthNextjsMiddleware(async (request, { convexAuth }) => {
  // Si el usuario está autenticado y trata de ir al login, redirigir a workspace
  if (isLoginPage(request) && (await convexAuth.isAuthenticated())) {
    const taskId = request.nextUrl.searchParams.get("taskId");
    return nextjsMiddlewareRedirect(request, taskId ? `/workspace/requests?taskId=${encodeURIComponent(taskId)}` : "/workspace");
  }
  // Si el usuario no está autenticado y trata de ir a ruta protegida, redirigir a login
  if (isProtectedRoute(request) && !(await convexAuth.isAuthenticated())) {
    const internalTaskId = request.nextUrl.pathname === "/workspace/control-panel" ? request.nextUrl.searchParams.get("taskId") : null;
    if (internalTaskId) {
      return nextjsMiddlewareRedirect(request, `/login/internal?taskId=${encodeURIComponent(internalTaskId)}`);
    }
    const taskId = request.nextUrl.pathname === "/workspace/requests" ? request.nextUrl.searchParams.get("taskId") : null;
    return nextjsMiddlewareRedirect(request, taskId ? `/login?taskId=${encodeURIComponent(taskId)}` : "/login");
  }
});

export const config = {
  matcher: ["/((?!.*\\..*|_next).*)", "/", "/(api|trpc)(.*)"],
};
