import { useTranslation } from "react-i18next";
import { GitBranch } from "lucide-react";
import type { AgentEdge, AgentNode } from "../types";

export function EdgeInspector({
  edge,
  sourceNode,
  onSetRoute,
}: {
  edge: AgentEdge;
  sourceNode: AgentNode | null;
  onSetRoute: (route: string | null) => void;
}) {
  const { t } = useTranslation();
  const isRouter = sourceNode?.data.manifestId === "control.router";
  const routes = Array.isArray(sourceNode?.data.config?.routes)
    ? (sourceNode!.data.config.routes as unknown[]).map(String)
    : [];
  const current = (edge.data as { route?: string } | undefined)?.route ?? "";
  return (
    <aside className="inspector">
      <div className="inspector-heading">
        <div className="inspector-title">
          <span
            className="inspector-icon"
            style={{ color: "#7c8b9c", background: "#7c8b9c1a" }}
          >
            <GitBranch size={14} />
          </span>
          <div>
            <strong>{t("Connection")}</strong>
            <small>
              {edge.source} → {edge.target}
            </small>
          </div>
        </div>
      </div>
      <div className="config-panel">
        {isRouter ? (
          routes.length ? (
            <div className="field">
              <label>{t("Route")}</label>
              <select
                value={current}
                onChange={(event) => onSetRoute(event.target.value || null)}
              >
                <option value="">{t("Unconditional (any route)")}</option>
                {routes.map((route) => (
                  <option key={route} value={route}>
                    {route}
                  </option>
                ))}
              </select>
              <p className="edge-hint">
                {t("Only the branch matching the Router's chosen route runs. Unconditional connections always run.")}
              </p>
            </div>
          ) : (
            <div className="empty-field">
              {t("Add routes to the Router block to branch this connection.")}
            </div>
          )
        ) : (
          <div className="empty-field">
            {t("Conditional routing applies to connections leaving a Router block.")}
          </div>
        )}
      </div>
    </aside>
  );
}
