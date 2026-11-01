import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { UserRolesEditor } from "../app/components/UserRolesEditor";

// No queries or mutations run during server rendering; this does not connect to Convex.
function render(props: Parameters<typeof UserRolesEditor>[0]) {
  const client = new ConvexReactClient("https://test.convex.cloud");
  return renderToStaticMarkup(createElement(ConvexProvider, { client, children: createElement(UserRolesEditor, props) }));
}

test("the internal role selector offers user/admin and never super_admin", () => {
  const html = render({ kind: "internal", userId: "internal" as any });
  assert.match(html, /<option value="user"/);
  assert.match(html, /<option value="admin"/);
  assert.match(html, /<option value="" disabled="" selected="">Seleccionar rol<\/option>/);
  assert.doesNotMatch(html, /<option value="super_admin"/);
  assert.doesNotMatch(html, /<section|Roles del usuario|Rol de trabajo|Guardar roles/);
});

test("an explicitly saved user role stays selected instead of the placeholder", () => {
  const html = render({ kind: "internal", userId: "internal" as any, platformRole: "user" });
  assert.match(html, /<option value="user" selected="">Usuario<\/option>/);
  assert.doesNotMatch(html, /<option value=""[^>]*selected/);
});

test("existing super_admin profiles display a read-only level without a selector", () => {
  const html = render({ kind: "internal", userId: "super" as any, platformRole: "super_admin" });
  assert.match(html, /readOnly=""[^>]*value="Super admin"/);
  assert.doesNotMatch(html, /<select/);
});

test("external coordinator settings never display administration levels", () => {
  const html = render({ kind: "external", approvedExternalUserId: "external" as any, isCoordinator: true });
  assert.match(html, /Coordinador externo/);
  assert.match(html, /Roles del usuario/);
  assert.match(html, /Guardar roles/);
  assert.doesNotMatch(html, /Nivel de administración|<select|Rol de trabajo/);
});
