import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  Check,
  LoaderCircle,
  Monitor,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { api } from "../api/client";
import {
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  usePreferencesStore,
} from "../store/preferences";
import type { UiLocale } from "../types";

const scales: Array<{ value: number; label: string; hint: string }> = [
  { value: 90, label: "90%", hint: "Compact" },
  { value: 100, label: "100%", hint: "Default" },
  { value: 110, label: "110%", hint: "Comfortable" },
  { value: 120, label: "120%", hint: "Large" },
];

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const [tab, setTab] = useState<"appearance" | "providers">("appearance");
  const fontScale = usePreferencesStore((s) => s.fontScale);
  const setFontScale = usePreferencesStore((s) => s.setFontScale);
  const {
    data = [],
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ["providers"],
    queryFn: api.providers,
    enabled: tab === "providers",
  });
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [models, setModels] = useState<Record<string, string>>({});
  const [persist, setPersist] = useState(true);
  const [message, setMessage] = useState("");
  useEffect(() => {
    setModels((current) =>
      Object.fromEntries(
        data.map((provider) => [
          provider.provider,
          current[provider.provider] ?? provider.default_model ?? "",
        ]),
      ),
    );
  }, [data]);
  const saveKey = async (provider: string) => {
    const value = keys[provider]?.trim();
    if (!value) return;
    try {
      const result = await api.setProviderSecret(provider, value, persist);
      setKeys((current) => ({ ...current, [provider]: "" }));
      setMessage(`${provider} ${t("Configured")} · ${result.storage}`);
      await refetch();
    } catch {
      setMessage(`${t("Could not save provider setting")} · ${provider}`);
    }
  };
  const saveModel = async (provider: string) => {
    try {
      await api.setProviderSettings(provider, models[provider] ?? "");
      setMessage(`${provider} · ${t("Default model saved")}`);
      await refetch();
    } catch {
      setMessage(`${t("Could not save provider setting")} · ${provider}`);
    }
  };
  const remove = async (provider: string) => {
    try {
      await api.deleteProviderSecret(provider);
      setMessage(`${provider} · ${t("credential removed")}`);
      await refetch();
    } catch {
      setMessage(`${t("Could not remove")} ${provider}`);
    }
  };
  const changeLocale = (locale: UiLocale) => {
    void i18n.changeLanguage(locale);
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="settings-modal"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="settings-sidebar">
          <div className="settings-brand">
            <strong>{t("Settings")}</strong>
            <span>{t("Device preferences")}</span>
          </div>
          <button
            className={tab === "appearance" ? "active" : ""}
            onClick={() => setTab("appearance")}
          >
            <Monitor size={14} /> {t("Appearance")}
          </button>
          <button
            className={tab === "providers" ? "active" : ""}
            onClick={() => setTab("providers")}
          >
            <ShieldCheck size={14} /> {t("Providers")}
          </button>
        </div>
        <div className="settings-main">
          <div className="modal-head">
            <div>
              <div className="eyebrow">
                {t(tab === "appearance" ? "DEVICE DISPLAY" : "LOCAL SECRETS")}
              </div>
              <h2>
                {t(tab === "appearance" ? "Appearance" : "Model providers")}
              </h2>
              <p>
                {t(
                  tab === "appearance"
                    ? "This preference applies to this browser and is not saved with projects."
                    : "Keys stay in the local runner and are never returned to the browser.",
                )}
              </p>
            </div>
            <button
              className="small-icon"
              aria-label={t("Close settings")}
              onClick={onClose}
            >
              <X size={16} />
            </button>
          </div>
          {tab === "appearance" ? (
            <div className="appearance-panel">
              <div className="settings-section">
                <label>{t("Interface text size")}</label>
                <p>
                  {t(
                    "Canvas nodes, graph controls and the code editor retain their own scale.",
                  )}
                </p>
                <div className="font-scale-control">
                  {scales.map((scale) => (
                    <button
                      key={scale.value}
                      className={fontScale === scale.value ? "active" : ""}
                      onClick={() => setFontScale(scale.value)}
                    >
                      <span style={{ fontSize: `${scale.value / 10}px` }}>
                        Aa
                      </span>
                      <strong>{scale.label}</strong>
                      <small>{t(scale.hint)}</small>
                      {fontScale === scale.value && <Check size={12} />}
                    </button>
                  ))}
                </div>
                <div className="font-scale-slider">
                  <input
                    type="range"
                    min={FONT_SCALE_MIN}
                    max={FONT_SCALE_MAX}
                    step={1}
                    value={fontScale}
                    aria-label={t("Custom text size")}
                    onChange={(event) =>
                      setFontScale(Number(event.target.value))
                    }
                  />
                  <div className="font-scale-value">
                    <input
                      type="number"
                      min={FONT_SCALE_MIN}
                      max={FONT_SCALE_MAX}
                      value={fontScale}
                      onChange={(event) =>
                        setFontScale(Number(event.target.value))
                      }
                    />
                    <span>%</span>
                  </div>
                </div>
              </div>
              <div className="settings-section language-section">
                <label>{t("Language")}</label>
                <p>{t("Choose the interface language for this browser.")}</p>
                <div className="language-control">
                  <button
                    className={i18n.language === "en" ? "active" : ""}
                    onClick={() => changeLocale("en")}
                  >
                    {t("English")}
                  </button>
                  <button
                    className={i18n.language === "zh-CN" ? "active" : ""}
                    onClick={() => changeLocale("zh-CN")}
                  >
                    {t("Chinese")}
                  </button>
                </div>
              </div>
              <div className="preference-note">
                <Monitor size={15} />
                <div>
                  <strong>{t("Device-level preference")}</strong>
                  <span>
                    {t(
                      "Stored with a versioned local schema. Invalid or older values safely reset to 100%.",
                    )}
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <>
              <label className="persist-toggle">
                <input
                  type="checkbox"
                  checked={persist}
                  onChange={(event) => setPersist(event.target.checked)}
                />
                <span>{t("Persist in the operating system keychain")}</span>
              </label>
              <div className="provider-list">
                {isLoading ? (
                  <div className="provider-loading">
                    <LoaderCircle className="spin" size={16} />{" "}
                    {t("Loading providers")}
                  </div>
                ) : (
                  data.map((provider) => (
                    <div className="provider-row" key={provider.provider}>
                      <div className="provider-title">
                        <span
                          className={`provider-status ${provider.configured ? "configured" : ""}`}
                        />
                        <div>
                          <strong>{provider.provider}</strong>
                          <small>
                            {provider.configured
                              ? `${t("Configured")} · ${provider.storage}`
                              : t("Not configured")}
                          </small>
                        </div>
                      </div>
                      <div className="provider-key">
                        <input
                          type="password"
                          autoComplete="new-password"
                          placeholder={t("Enter API key")}
                          value={keys[provider.provider] ?? ""}
                          onChange={(event) =>
                            setKeys((current) => ({
                              ...current,
                              [provider.provider]: event.target.value,
                            }))
                          }
                        />
                        <button
                          className="tool-button with-label primary"
                          disabled={!keys[provider.provider]?.trim()}
                          onClick={() => saveKey(provider.provider)}
                        >
                          {t("Save key")}
                        </button>
                        {provider.configured && (
                          <button
                            className="tool-button"
                            title={t("Remove credential")}
                            onClick={() => remove(provider.provider)}
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                      <label className="provider-model">
                        <span>{t("Default model")}</span>
                        <small>
                          {t(
                            "Used when an LLM node leaves its model field empty.",
                          )}
                        </small>
                        <div>
                          <input
                            value={models[provider.provider] ?? ""}
                            placeholder="model-id"
                            onChange={(event) =>
                              setModels((current) => ({
                                ...current,
                                [provider.provider]: event.target.value,
                              }))
                            }
                          />
                          <button
                            className="tool-button with-label"
                            onClick={() => saveModel(provider.provider)}
                          >
                            {t("Save model")}
                          </button>
                        </div>
                      </label>
                      <div className="provider-capabilities">
                        {provider.capabilities.map((capability) => (
                          <span key={capability}>{capability}</span>
                        ))}
                      </div>
                    </div>
                  ))
                )}
              </div>
              {message && <div className="settings-message">{message}</div>}
            </>
          )}
          <div className="modal-foot">
            <span>
              <ShieldCheck size={13} />{" "}
              {t(
                tab === "appearance"
                  ? "Project exports do not contain display settings"
                  : "Project files store provider references only",
              )}
            </span>
            <button className="tool-button with-label" onClick={onClose}>
              {t("Done")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
