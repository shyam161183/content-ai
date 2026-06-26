"use client";

import { useEffect, useMemo, useState } from "react";

type Opportunity = {
  query: string;
  page?: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  score: number;
  type: "CTR lift" | "Near page one" | "Content cluster";
  draftAngle: string;
};

type DraftIdea = {
  title: string;
  primaryKeyword: string;
  rationale: string;
  facebookPost: string;
};

type GscResponse = {
  siteUrl: string;
  startDate: string;
  endDate: string;
  totals: {
    rows: number;
    clicks: number;
    impressions: number;
    averagePosition: number;
  };
  opportunities: Opportunity[];
  draftIdeas: DraftIdea[];
};

type ContentDraft = {
  id?: string;
  title: string;
  seoTitle: string;
  metaDescription: string;
  slug: string;
  excerpt: string;
  primaryKeyword: string;
  secondaryKeywords: string[];
  outline: string[];
  body: string;
  faq: Array<{ question: string; answer: string }>;
  facebookPost: string;
  safetyNotes: string[];
  approvalStatus: "Draft" | "Ready for review" | "Approved";
  publishStatus?: {
    wix?: "Not sent" | "Ready" | "Created" | "Needs credentials" | "Error";
    facebook?: "Not sent" | "Ready" | "Published" | "Needs credentials" | "Error";
    lastMessage?: string;
  };
  generationSource?: "Template" | "OpenAI";
  createdAt?: string;
  updatedAt?: string;
};

type ConnectorStatus = {
  wix: { configured: boolean; needs: string[] };
  facebook: { configured: boolean; needs: string[] };
};

function dateDaysAgo(days: number) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
}

export default function DashboardClient() {
  const [startDate, setStartDate] = useState(dateDaysAgo(90));
  const [endDate, setEndDate] = useState(new Date().toISOString().slice(0, 10));
  const [data, setData] = useState<GscResponse | null>(null);
  const [selectedDraft, setSelectedDraft] = useState<ContentDraft | null>(null);
  const [savedDrafts, setSavedDrafts] = useState<ContentDraft[]>([]);
  const [connectors, setConnectors] = useState<ConnectorStatus | null>(null);
  const [draftLoadingFor, setDraftLoadingFor] = useState("");
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const formatter = useMemo(() => new Intl.NumberFormat("en-AU"), []);

  useEffect(() => {
    loadSavedDrafts();
    loadConnectorStatus();
  }, []);

  async function loadSavedDrafts() {
    try {
      const response = await fetch("/api/drafts");
      const payload = await response.json();

      if (response.ok) {
        setSavedDrafts(payload.drafts || []);
      }
    } catch {
      // Saved drafts are useful, but GSC discovery should still work without them.
    }
  }

  async function loadConnectorStatus() {
    try {
      const response = await fetch("/api/connectors/status");
      const payload = await response.json();

      if (response.ok) {
        setConnectors(payload);
      }
    } catch {
      setConnectors(null);
    }
  }

  async function loadOpportunities() {
    setLoading(true);
    setError("");
    setNotice("");

    try {
      const response = await fetch(
        `/api/gsc/opportunities?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`
      );
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Unable to load GSC opportunities.");
      }

      setData(payload);
      setSelectedDraft(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to load GSC opportunities.");
    } finally {
      setLoading(false);
    }
  }

  async function disconnect() {
    await fetch("/api/auth/logout", { method: "POST" });
    setData(null);
    setSelectedDraft(null);
  }

  async function generateDraft(opportunity: Opportunity) {
    setDraftLoadingFor(opportunity.query);
    setError("");
    setNotice("");

    try {
      const response = await fetch("/api/drafts/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ opportunity })
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Unable to generate draft.");
      }

      setSelectedDraft(payload.draft);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to generate draft.");
    } finally {
      setDraftLoadingFor("");
    }
  }

  function updateDraft<K extends keyof ContentDraft>(key: K, value: ContentDraft[K]) {
    setSelectedDraft((current) => {
      if (!current) return current;

      return {
        ...current,
        [key]: value,
        approvalStatus: current.approvalStatus === "Approved" ? "Ready for review" : current.approvalStatus
      };
    });
  }

  async function saveSelectedDraft(status?: ContentDraft["approvalStatus"]) {
    if (!selectedDraft) return;

    setSaving(true);
    setError("");
    setNotice("");

    const draftToSave = {
      ...selectedDraft,
      approvalStatus: status || selectedDraft.approvalStatus
    };

    try {
      const response = await fetch("/api/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draftToSave)
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Unable to save draft.");
      }

      setSelectedDraft(payload.draft);
      await loadSavedDrafts();
      setNotice(status === "Approved" ? "Draft approved and saved." : "Draft saved.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to save draft.");
    } finally {
      setSaving(false);
    }
  }

  async function exportSelectedDraft() {
    if (!selectedDraft) return;

    setError("");
    setNotice("");

    try {
      const response = await fetch("/api/drafts/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(selectedDraft)
      });

      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload.error || "Unable to export draft.");
      }

      const blob = await response.blob();
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = `${selectedDraft.slug || "content-draft"}.md`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(href);
      setNotice("Markdown export created.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to export draft.");
    }
  }

  async function runPublishAction(kind: "wix-draft" | "facebook") {
    if (!selectedDraft) return;

    setPublishing(kind);
    setError("");
    setNotice("");

    try {
      const response = await fetch(`/api/publish/${kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(selectedDraft)
      });
      const payload = await response.json();

      if (!response.ok && !payload.message) {
        throw new Error(payload.error || "Publishing action failed.");
      }

      const nextStatus = {
        ...selectedDraft.publishStatus,
        lastMessage: payload.message
      };

      if (kind === "wix-draft") {
        nextStatus.wix = payload.status;
      } else {
        nextStatus.facebook = payload.status;
      }

      const nextDraft: ContentDraft = {
        ...selectedDraft,
        publishStatus: nextStatus
      };

      setSelectedDraft(nextDraft);
      setNotice(payload.message || "Publishing action completed.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Publishing action failed.");
    } finally {
      setPublishing("");
      await loadConnectorStatus();
    }
  }

  return (
    <div className="shell">
      <div className="topbar">
        <div className="brand">
          <strong>Southtown Content Agent</strong>
          <span>Wix Blog, Google Search Console, and Facebook draft workflow</span>
        </div>
        <div className="controls">
          <a className="button secondary" href="/api/auth/google">
            Connect Google
          </a>
          <button className="button secondary" onClick={disconnect}>
            Disconnect
          </button>
        </div>
      </div>

      <main className="main">
        <section className="toolbar">
          <div>
            <strong>Search Console property</strong>
            <div className="muted">https://www.southtowndentaltoowoomba.com.au/</div>
          </div>
          <div className="controls">
            <div className="field">
              <label htmlFor="startDate">Start</label>
              <input
                id="startDate"
                type="date"
                value={startDate}
                onChange={(event) => setStartDate(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="endDate">End</label>
              <input
                id="endDate"
                type="date"
                value={endDate}
                onChange={(event) => setEndDate(event.target.value)}
              />
            </div>
            <div className="field">
              <label>&nbsp;</label>
              <button className="button" disabled={loading} onClick={loadOpportunities}>
                {loading ? "Loading..." : "Find Ideas"}
              </button>
            </div>
          </div>
        </section>

        {error ? <div className="error">{error}</div> : null}
        {notice ? <div className="notice">{notice}</div> : null}

        {data ? (
          <>
            <section className="stats">
              <div className="stat">
                <span>Rows scanned</span>
                <strong>{formatter.format(data.totals.rows)}</strong>
              </div>
              <div className="stat">
                <span>Clicks</span>
                <strong>{formatter.format(Math.round(data.totals.clicks))}</strong>
              </div>
              <div className="stat">
                <span>Impressions</span>
                <strong>{formatter.format(Math.round(data.totals.impressions))}</strong>
              </div>
              <div className="stat">
                <span>Avg position</span>
                <strong>{data.totals.averagePosition.toFixed(1)}</strong>
              </div>
            </section>

            <section className="connector-row">
              <div className="connector">
                <strong>Wix Blog</strong>
                <span className={connectors?.wix.configured ? "ok" : "warn"}>
                  {connectors?.wix.configured
                    ? "Configured"
                    : `Needs ${connectors?.wix.needs.join(", ") || "credentials"}`}
                </span>
              </div>
              <div className="connector">
                <strong>Facebook Page</strong>
                <span className={connectors?.facebook.configured ? "ok" : "warn"}>
                  {connectors?.facebook.configured
                    ? "Configured"
                    : `Needs ${connectors?.facebook.needs.join(", ") || "credentials"}`}
                </span>
              </div>
            </section>

            <section className="grid">
              <div className="panel">
                <header>
                  <h2>SEO Opportunities</h2>
                  <span className="muted">{data.startDate} to {data.endDate}</span>
                </header>
                <div className="panel-body">
                  <table>
                    <thead>
                      <tr>
                        <th>Query</th>
                        <th>Type</th>
                        <th>Clicks</th>
                        <th>Impressions</th>
                        <th>CTR</th>
                        <th>Position</th>
                        <th>Draft</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.opportunities.map((item) => (
                        <tr key={`${item.query}-${item.page}`}>
                          <td>
                            <strong>{item.query}</strong>
                            <div className="muted">{item.draftAngle}</div>
                          </td>
                          <td>
                            <span
                              className={`pill ${
                                item.type === "CTR lift"
                                  ? "green"
                                  : item.type === "Near page one"
                                    ? "blue"
                                    : "amber"
                              }`}
                            >
                              {item.type}
                            </span>
                          </td>
                          <td>{formatter.format(item.clicks)}</td>
                          <td>{formatter.format(item.impressions)}</td>
                          <td>{(item.ctr * 100).toFixed(1)}%</td>
                          <td>{item.position.toFixed(1)}</td>
                          <td>
                            <button
                              className="button compact"
                              disabled={draftLoadingFor === item.query}
                              onClick={() => generateDraft(item)}
                            >
                              {draftLoadingFor === item.query ? "..." : "Generate"}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <aside className="panel">
                <header>
                  <h2>{selectedDraft ? "Review Draft" : "Draft Queue"}</h2>
                  <span className="muted">{selectedDraft?.approvalStatus || "Approval first"}</span>
                </header>
                <div className="panel-body">
                  {selectedDraft ? (
                    <div className="draft-editor">
                      <div className="field">
                        <label htmlFor="draftTitle">Wix Blog title</label>
                        <input
                          id="draftTitle"
                          value={selectedDraft.title}
                          onChange={(event) => updateDraft("title", event.target.value)}
                        />
                      </div>
                      <div className="source-line">
                        Generated by {selectedDraft.generationSource || "Template"}
                      </div>
                      <div className="field">
                        <label htmlFor="seoTitle">SEO title</label>
                        <input
                          id="seoTitle"
                          value={selectedDraft.seoTitle}
                          onChange={(event) => updateDraft("seoTitle", event.target.value)}
                        />
                      </div>
                      <div className="field">
                        <label htmlFor="slug">URL slug</label>
                        <input
                          id="slug"
                          value={selectedDraft.slug}
                          onChange={(event) => updateDraft("slug", event.target.value)}
                        />
                      </div>
                      <div className="field">
                        <label htmlFor="metaDescription">Meta description</label>
                        <textarea
                          id="metaDescription"
                          rows={3}
                          value={selectedDraft.metaDescription}
                          onChange={(event) => updateDraft("metaDescription", event.target.value)}
                        />
                      </div>
                      <div className="field">
                        <label htmlFor="outline">Outline</label>
                        <textarea
                          id="outline"
                          rows={7}
                          value={selectedDraft.outline.join("\n")}
                          onChange={(event) => updateDraft("outline", event.target.value.split("\n"))}
                        />
                      </div>
                      <div className="field">
                        <label htmlFor="body">Blog draft</label>
                        <textarea
                          id="body"
                          rows={16}
                          value={selectedDraft.body}
                          onChange={(event) => updateDraft("body", event.target.value)}
                        />
                      </div>
                      <div className="field">
                        <label htmlFor="facebookPost">Facebook post draft</label>
                        <textarea
                          id="facebookPost"
                          rows={6}
                          value={selectedDraft.facebookPost}
                          onChange={(event) => updateDraft("facebookPost", event.target.value)}
                        />
                      </div>
                      <div className="safety">
                        <strong>Dental content safety checks</strong>
                        <ul>
                          {selectedDraft.safetyNotes.map((note) => (
                            <li key={note}>{note}</li>
                          ))}
                        </ul>
                      </div>
                      <div className="review-actions">
                        <button className="button secondary" onClick={exportSelectedDraft}>
                          Export Markdown
                        </button>
                        <button
                          className="button secondary"
                          disabled={saving}
                          onClick={() => saveSelectedDraft()}
                        >
                          {saving ? "Saving..." : "Save Draft"}
                        </button>
                        <button
                          className="button secondary"
                          disabled={saving}
                          onClick={() => saveSelectedDraft("Ready for review")}
                        >
                          Needs Edits
                        </button>
                        <button
                          className="button"
                          disabled={saving}
                          onClick={() => saveSelectedDraft("Approved")}
                        >
                          Mark Approved
                        </button>
                      </div>
                      <div className="publish-box">
                        <div>
                          <strong>Approved publishing actions</strong>
                          <p>
                            Save and approve the draft before sending anything to Wix or Facebook.
                          </p>
                          {selectedDraft.publishStatus?.lastMessage ? (
                            <p className="publish-message">{selectedDraft.publishStatus.lastMessage}</p>
                          ) : null}
                        </div>
                        <div className="review-actions">
                          <button
                            className="button secondary"
                            disabled={selectedDraft.approvalStatus !== "Approved" || publishing === "wix-draft"}
                            onClick={() => runPublishAction("wix-draft")}
                          >
                            {publishing === "wix-draft" ? "Preparing..." : "Prepare Wix Draft"}
                          </button>
                          <button
                            className="button secondary"
                            disabled={selectedDraft.approvalStatus !== "Approved" || publishing === "facebook"}
                            onClick={() => runPublishAction("facebook")}
                          >
                            {publishing === "facebook" ? "Publishing..." : "Publish Facebook"}
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <>
                      {savedDrafts.length ? (
                        <div className="saved-list">
                          <div className="section-label">Saved Drafts</div>
                          {savedDrafts.map((draft) => (
                            <button
                              className="saved-draft"
                              key={draft.id || draft.slug}
                              onClick={() => setSelectedDraft(draft)}
                            >
                              <strong>{draft.title}</strong>
                              <span>{draft.primaryKeyword} · {draft.approvalStatus}</span>
                            </button>
                          ))}
                        </div>
                      ) : null}
                      <div className="ideas">
                        <div className="section-label">Suggested Queue</div>
                        {data.draftIdeas.map((idea) => (
                          <article className="idea" key={idea.title}>
                            <h3>{idea.title}</h3>
                            <p><strong>Keyword:</strong> {idea.primaryKeyword}</p>
                            <p>{idea.rationale}</p>
                            <p><strong>Facebook draft:</strong> {idea.facebookPost}</p>
                          </article>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </aside>
            </section>
          </>
        ) : (
          <section className="panel">
            <header>
              <h2>Ready For Google Search Console</h2>
            </header>
            <div className="panel-body">
              <p className="muted">
                Add the Google client secret to <strong>.env.local</strong>, connect Google, then
                pull Search Console keywords to generate Wix Blog and Facebook draft ideas.
              </p>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
