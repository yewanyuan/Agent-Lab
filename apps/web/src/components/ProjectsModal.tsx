import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  Check,
  FolderOpen,
  LoaderCircle,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { ApiError, api } from "../api/client";

export function ProjectsModal({
  currentProjectId,
  onClose,
  onOpen,
  onNew,
  onDeleted,
}: {
  currentProjectId: string;
  onClose: () => void;
  onOpen: (projectId: string) => void;
  onNew: () => void;
  onDeleted?: (projectId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.listProjects });
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [error, setError] = useState("");
  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api.renameProject(id, name),
    onSuccess: () => {
      setRenamingId(null);
      setError("");
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
    onError: () => setError(t("Could not rename project")),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteProject(id),
    onSuccess: (_result, id) => {
      setError("");
      onDeleted?.(id);
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
    onError: (mutationError) =>
      setError(
        mutationError instanceof ApiError && mutationError.status === 409
          ? t("Project has active runs or evaluations; cancellation was requested. Retry deletion shortly.")
          : t("Could not delete project"),
      ),
  });
  const submitRename = (id: string) => {
    if (renameValue.trim()) rename.mutate({ id, name: renameValue.trim() });
  };
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="projects-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="eyebrow">{t("WORKSPACE")}</div>
            <h2>{t("Projects")}</h2>
            <p>{t("Saved projects live in the local runner database.")}</p>
          </div>
          <button className="small-icon" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="projects-list">
          {projects.isLoading ? (
            <div className="loading-row">
              <LoaderCircle className="spin" size={14} /> {t("Loading projects")}
            </div>
          ) : projects.error ? (
            <div className="projects-empty">
              <FolderOpen size={18} />
              <strong>{t("Projects unavailable")}</strong>
              <span>{t("Could not read the project list from the runner.")}</span>
            </div>
          ) : projects.data?.length ? (
            projects.data.map((project) => (
              <div
                className={`project-item ${project.id === currentProjectId ? "current" : ""}`}
                key={project.id}
              >
                {renamingId === project.id ? (
                  <>
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={(event) => setRenameValue(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") submitRename(project.id);
                        if (event.key === "Escape") setRenamingId(null);
                      }}
                    />
                    <button
                      className="small-icon"
                      title={t("Save")}
                      disabled={!renameValue.trim() || rename.isPending}
                      onClick={() => submitRename(project.id)}
                    >
                      <Check size={14} />
                    </button>
                    <button className="small-icon" onClick={() => setRenamingId(null)}>
                      <X size={14} />
                    </button>
                  </>
                ) : (
                  <>
                    <button className="project-open" onClick={() => onOpen(project.id)}>
                      <strong>{project.name}</strong>
                      <small>
                        {project.description || t("No description")} ·{" "}
                        {new Date(project.updated_at).toLocaleString(i18n.language)}
                      </small>
                    </button>
                    {project.id === currentProjectId && (
                      <span className="current-tag">{t("CURRENT")}</span>
                    )}
                    <button
                      className="small-icon"
                      title={t("Rename project")}
                      onClick={() => {
                        setRenamingId(project.id);
                        setRenameValue(project.name);
                      }}
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      className="small-icon"
                      title={t("Delete project")}
                      disabled={remove.isPending}
                      onClick={() => {
                        if (window.confirm(`${t("Delete project")} "${project.name}"?`))
                          remove.mutate(project.id);
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </>
                )}
              </div>
            ))
          ) : (
            <div className="projects-empty">
              <FolderOpen size={18} />
              <strong>{t("No saved projects")}</strong>
              <span>{t("Save the current design or start from a template.")}</span>
            </div>
          )}
        </div>
        {error && <div className="inline-error">{error}</div>}
        <div className="modal-foot">
          <button className="tool-button with-label" onClick={onNew}>
            <Plus size={14} /> {t("New from template")}
          </button>
          <span className="tabs-spacer" />
          <button className="tool-button" onClick={onClose}>
            {t("Done")}
          </button>
        </div>
      </div>
    </div>
  );
}
