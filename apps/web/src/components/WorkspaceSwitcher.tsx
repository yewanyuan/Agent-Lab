import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, FolderOpen, History } from "lucide-react";
import { api } from "../api/client";

export function WorkspaceSwitcher({
  projectId,
  projectName,
  revisionId,
  revisionSequence,
  onOpenProject,
  onOpenRevision,
  onManageProjects,
}: {
  projectId: string;
  projectName: string;
  revisionId: string | null;
  revisionSequence: number;
  onOpenProject: (id: string) => void;
  onOpenRevision: (id: string) => void;
  onManageProjects: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const saved = projectId !== "proj-local";
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: api.listProjects,
    enabled: open,
  });
  const revisions = useQuery({
    queryKey: ["revisions", projectId],
    queryFn: () => api.listRevisions(projectId),
    enabled: open && saved,
  });
  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node))
        setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);
  return (
    <div className="workspace-switcher" ref={ref}>
      <button
        className={`project-switcher ${open ? "open" : ""}`}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="status-dot" />
        <span className="switcher-name">{projectName}</span>
        <span className="muted">/</span>
        <span className="switcher-rev">
          {t("Revision")} {revisionSequence}
        </span>
        {revisionId && (
          <span className="revision-id" title={revisionId}>
            {revisionId.slice(0, 7)}
          </span>
        )}
        <ChevronDown size={14} className="switcher-chevron" />
      </button>
      {open && (
        <div className="switcher-menu">
          <div className="switcher-section">
            <div className="switcher-label">
              <FolderOpen size={12} /> {t("Projects")}
            </div>
            {projects.data?.length ? (
              projects.data.slice(0, 8).map((project) => (
                <button
                  key={project.id}
                  className={project.id === projectId ? "active" : ""}
                  onClick={() => {
                    onOpenProject(project.id);
                    setOpen(false);
                  }}
                >
                  <span className="switcher-item-name">{project.name}</span>
                  {project.id === projectId && <Check size={12} />}
                </button>
              ))
            ) : (
              <div className="switcher-empty">{t("No saved projects")}</div>
            )}
            <button
              className="switcher-more"
              onClick={() => {
                onManageProjects();
                setOpen(false);
              }}
            >
              {t("Manage projects")}
            </button>
          </div>
          {saved && (
            <div className="switcher-section">
              <div className="switcher-label">
                <History size={12} /> {t("Versions")}
              </div>
              {revisions.data?.length ? (
                revisions.data.slice(0, 8).map((revision) => (
                  <button
                    key={revision.id}
                    className={revision.id === revisionId ? "active" : ""}
                    onClick={() => {
                      onOpenRevision(revision.id);
                      setOpen(false);
                    }}
                  >
                    <span className="switcher-item-name">
                      {t("Revision")} {revision.sequence}
                    </span>
                    <small>
                      {new Date(revision.created_at).toLocaleDateString(
                        i18n.language,
                      )}
                    </small>
                    {revision.id === revisionId && <Check size={12} />}
                  </button>
                ))
              ) : (
                <div className="switcher-empty">—</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
