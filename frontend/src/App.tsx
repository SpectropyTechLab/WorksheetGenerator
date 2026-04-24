import { useEffect, useMemo, useState } from 'react';
import './App.css';
import UploadForm from './components/UploadForm';
import LoginForm from './components/LoginForm';
import type { WorksheetCreateResponse, WorksheetStatus, WorksheetStatusResponse } from './types';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000';
const WORKFLOW_STEPS: WorksheetStatus[] = ['extracting', 'generating', 'compiling', 'ready'];

async function readErrorMessage(response: Response) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      const data = await response.json();
      if (typeof data?.error === 'string') return data.error;
      if (typeof data?.message === 'string') return data.message;
      return JSON.stringify(data);
    } catch {
      return 'Request failed';
    }
  }

  try {
    return await response.text();
  } catch {
    return 'Request failed';
  }
}

function App() {
  const [worksheetId, setWorksheetId] = useState<string | null>(null);
  const [status, setStatus] = useState<WorksheetStatus | null>(null);
  const [chapterName, setChapterName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [docxPreviewUrl, setDocxPreviewUrl] = useState<string | null>(null);
  const [authToken, setAuthToken] = useState<string | null>(() => localStorage.getItem('auth_token') || null);
  const [authRole, setAuthRole] = useState<string | null>(() => localStorage.getItem('auth_role') || null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [workspaceView, setWorkspaceView] = useState<'users' | 'worksheet'>('worksheet');
  const [users, setUsers] = useState<Array<{ id: string; username: string; role: string }>>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [userForm, setUserForm] = useState({ username: '', password: '', role: 'user' });
  const [editingUserId, setEditingUserId] = useState<string | null>(null);

  const isAuthenticated = Boolean(authToken);

  const downloadDocxUrl = useMemo(() => {
    if (!worksheetId || status !== 'ready' || !authToken) return null;
    return `${API_BASE}/api/worksheet/${worksheetId}/docx?token=${encodeURIComponent(authToken)}`;
  }, [worksheetId, status, authToken]);

  const officePreviewUrl = useMemo(() => {
    if (!docxPreviewUrl) return null;
    return `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(docxPreviewUrl)}`;
  }, [docxPreviewUrl]);

  const currentStepIndex = useMemo(() => {
    if (!status) return -1;
    if (status === 'failed') return 1;
    return WORKFLOW_STEPS.indexOf(status);
  }, [status]);

  useEffect(() => {
    if (!worksheetId || !status || status === 'ready' || status === 'failed') return;

    const intervalId = window.setInterval(async () => {
      try {
        const response = await fetch(`${API_BASE}/api/worksheet/${worksheetId}/status`, {
          headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
          cache: 'no-store'
        });
        if (!response.ok) {
          throw new Error((await readErrorMessage(response)) || 'Failed to fetch status');
        }
        const data = (await response.json()) as WorksheetStatusResponse;
        setStatus(data.status);
        setChapterName(data.chapter_name || chapterName);
        setError(data.status === 'failed' ? data.error || 'Worksheet processing failed' : null);
        if (data.status === 'ready') {
          setDocxPreviewUrl(data.docxUrl || null);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      }
    }, 2500);

    return () => window.clearInterval(intervalId);
  }, [worksheetId, status, authToken, chapterName]);

  useEffect(() => {
    if (!isAuthenticated || authRole !== 'admin' || !authToken) return;

    const loadUsers = async () => {
      setUsersLoading(true);
      setUsersError(null);
      try {
        const response = await fetch(`${API_BASE}/api/users`, {
          headers: { Authorization: `Bearer ${authToken}` }
        });
        if (!response.ok) {
          throw new Error((await readErrorMessage(response)) || 'Failed to load users');
        }
        const data = (await response.json()) as { users: Array<{ id: string; username: string; role: string }> };
        setUsers(data.users || []);
      } catch (err) {
        setUsersError(err instanceof Error ? err.message : 'Failed to load users');
      } finally {
        setUsersLoading(false);
      }
    };

    loadUsers();
  }, [isAuthenticated, authRole, authToken]);

  const handleSubmit = async (formData: FormData) => {
    setIsSubmitting(true);
    setError(null);
    setDocxPreviewUrl(null);
    setChapterName(String(formData.get('chapterName') || '').trim() || null);

    try {
      const response = await fetch(`${API_BASE}/api/worksheet`, {
        method: 'POST',
        body: formData,
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined
      });

      if (!response.ok) {
        throw new Error((await readErrorMessage(response)) || 'Upload failed');
      }

      const data = (await response.json()) as WorksheetCreateResponse;
      setWorksheetId(data.worksheetId);
      setStatus('extracting');
      setWorkspaceView('worksheet');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleLogin = async (username: string, password: string) => {
    setLoginError(null);
    const response = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    if (!response.ok) {
      setLoginError((await readErrorMessage(response)) || 'Login failed');
      return;
    }

    const data = (await response.json()) as { token: string; user: { username: string; role: string } };
    setAuthToken(data.token);
    setAuthRole(data.user.role);
    setWorkspaceView(data.user.role === 'admin' ? 'users' : 'worksheet');
    localStorage.setItem('auth_token', data.token);
    localStorage.setItem('auth_role', data.user.role);
  };

  const handleLogout = () => {
    setAuthToken(null);
    setAuthRole(null);
    localStorage.removeItem('auth_token');
    localStorage.removeItem('auth_role');
  };

  const handleUserCreate = async () => {
    if (!authToken) return;
    setUsersError(null);
    const payload = {
      username: userForm.username.trim(),
      password: userForm.password,
      role: userForm.role
    };

    if (!payload.username || !payload.password || !payload.role) {
      setUsersError('All fields are required.');
      return;
    }

    const response = await fetch(`${API_BASE}/api/users`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      setUsersError((await readErrorMessage(response)) || 'Failed to create user');
      return;
    }

    const data = (await response.json()) as { user: { id: string; username: string; role: string } };
    setUsers((prev) => [data.user, ...prev]);
    setUserForm({ username: '', password: '', role: 'user' });
    setEditingUserId(null);
  };

  const handleUserUpdate = async () => {
    if (!authToken || !editingUserId) return;
    setUsersError(null);

    const payload = {
      username: userForm.username.trim(),
      role: userForm.role,
      ...(userForm.password ? { password: userForm.password } : {})
    };

    const response = await fetch(`${API_BASE}/api/users/${editingUserId}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${authToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      setUsersError((await readErrorMessage(response)) || 'Failed to update user');
      return;
    }

    const data = (await response.json()) as { user: { id: string; username: string; role: string } };
    setUsers((prev) => prev.map((user) => (user.id === data.user.id ? data.user : user)));
    setUserForm({ username: '', password: '', role: 'user' });
    setEditingUserId(null);
  };

  const handleUserDelete = async (id: string) => {
    if (!authToken) return;
    setUsersError(null);
    const response = await fetch(`${API_BASE}/api/users/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${authToken}` }
    });

    if (!response.ok) {
      setUsersError((await readErrorMessage(response)) || 'Failed to delete user');
      return;
    }

    setUsers((prev) => prev.filter((user) => user.id !== id));
  };

  const startUserEdit = (user: { id: string; username: string; role: string }) => {
    setEditingUserId(user.id);
    setUserForm({ username: user.username, password: '', role: user.role });
  };

  const cancelUserEdit = () => {
    setEditingUserId(null);
    setUserForm({ username: '', password: '', role: 'user' });
  };

  return (
    <div className="app-shell">
      {!isAuthenticated ? (
        <main className="login-layout">
          <section className="login-brand-panel">
            <p className="eyebrow">Maestro Platform</p>
            <h1 className="hero-title">Worksheet Generator</h1>
            <p className="hero-subtitle">
              Create source-aligned premium worksheets from PDF and DOCX files and deliver them as Word documents.
            </p>

            <div className="hero-grid compact-grid">
              <article className="hero-card">
                <span className="hero-card-label">Source aligned</span>
                <strong>Concept-bound worksheet generation</strong>
                <span className="muted">The generator reads the source, audits concepts, and stays within the uploaded content scope.</span>
              </article>
              <article className="hero-card">
                <span className="hero-card-label">Output</span>
                <strong>Preview and DOCX download</strong>
                <span className="muted">Generated worksheets are compiled into Word and made ready for preview and download.</span>
              </article>
            </div>
          </section>

          <section className="panel login-panel">
            <div className="panel-header">
              <div>
                <p className="section-kicker">Login</p>
                <h2>Email and password</h2>
              </div>
            </div>
            <LoginForm onLogin={handleLogin} error={loginError} />
          </section>
        </main>
      ) : (
        <>
          <header className="hero workspace-hero">
            <div className="hero-inner single-line-header">
              <h1 className="workspace-title">Worksheet Generator Workspace</h1>
            </div>
          </header>

          <main className="content workspace-content">
            <section className="panel left-panel nav-panel">
              <div className="workspace-rail">
                <div className="workspace-rail-header">
                  <p className="section-kicker">Workspace</p>
                  <h2>Navigation</h2>
                </div>
                <button className="button secondary" type="button" onClick={handleLogout}>
                  Sign out
                </button>
              </div>

              <div className="workspace-nav">
                {authRole === 'admin' && (
                  <button
                    className={`workspace-nav-button ${workspaceView === 'users' ? 'active' : ''}`}
                    type="button"
                    onClick={() => setWorkspaceView('users')}
                  >
                    User management permissions
                  </button>
                )}
                <button
                  className={`workspace-nav-button ${workspaceView === 'worksheet' ? 'active' : ''}`}
                  type="button"
                  onClick={() => setWorkspaceView('worksheet')}
                >
                  Worksheet generator
                </button>
              </div>
            </section>

            <section className="panel right-panel content-panel">
              {authRole === 'admin' && workspaceView === 'users' ? (
                <div className="users-view">
                  <section className="panel sub-panel manager-form-panel">
                    <div className="content-topline">
                      <div>
                        <p className="section-kicker">Worksheet navigation</p>
                        <h2>User management permissions</h2>
                      </div>
                    </div>

                    <div className="manager-fields">
                      <label className="field">
                        <span>Email</span>
                        <input
                          type="email"
                          value={userForm.username}
                          onChange={(event) => setUserForm((prev) => ({ ...prev, username: event.target.value }))}
                        />
                      </label>
                      <label className="field">
                        <span>Password</span>
                        <input
                          type="text"
                          value={userForm.password}
                          onChange={(event) => setUserForm((prev) => ({ ...prev, password: event.target.value }))}
                        />
                      </label>
                      <label className="field">
                        <span>Role</span>
                        <select
                          value={userForm.role}
                          onChange={(event) =>
                            setUserForm((prev) => ({ ...prev, role: event.target.value as 'admin' | 'user' }))
                          }
                        >
                          <option value="user">User</option>
                          <option value="admin">Admin</option>
                        </select>
                      </label>
                    </div>

                    <div className="admin-actions">
                      {editingUserId ? (
                        <>
                          <button className="button primary" type="button" onClick={handleUserUpdate}>
                            Save changes
                          </button>
                          <button className="button secondary" type="button" onClick={cancelUserEdit}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button className="button primary" type="button" onClick={handleUserCreate}>
                          Add user
                        </button>
                      )}
                    </div>

                    {usersError && <p className="form-error">{usersError}</p>}
                  </section>

                  <section className="panel sub-panel manager-list-panel">
                    <div className="content-topline">
                      <div>
                        <p className="section-kicker">Existing users</p>
                        <h2>Existing users</h2>
                      </div>
                    </div>

                    <div className="status-steps">
                      {usersLoading ? (
                        <p className="muted">Loading users...</p>
                      ) : users.length ? (
                        users.map((user) => (
                          <div key={user.id} className="status-step">
                            <div className="step-badge">{user.role === 'admin' ? 'A' : 'U'}</div>
                            <div>
                              <h4>{user.username}</h4>
                              <p className="muted">Role: {user.role}</p>
                            </div>
                            <div className="admin-row-actions">
                              <button className="button secondary" type="button" onClick={() => startUserEdit(user)}>
                                Edit
                              </button>
                              <button className="button secondary" type="button" onClick={() => handleUserDelete(user.id)}>
                                Delete
                              </button>
                            </div>
                          </div>
                        ))
                      ) : (
                        <p className="muted">No users yet.</p>
                      )}
                    </div>
                  </section>
                </div>
              ) : (
                <div className="generator-view">
                  <div className="generator-header-row">
                    <div className="content-topline">
                      <div>
                        <p className="section-kicker">Worksheet generator</p>
                        <h2>Worksheet generator</h2>
                      </div>
                    </div>
                    <div className="content-topline content-topline-right">
                      <div>
                        <p className="section-kicker">Preview and download</p>
                        <h2>Preview and download</h2>
                      </div>
                      <span className={`status-pill ${status || 'idle'}`}>Status: {status ?? 'not started'}</span>
                    </div>
                  </div>

                  <div className="generator-content-row">
                    <div className="generator-form-panel">
                      <div className="content-subline">
                        <div>
                          <p className="section-kicker">Input form</p>
                        </div>
                      </div>
                    <UploadForm onSubmit={handleSubmit} isSubmitting={isSubmitting} />
                    </div>

                    <div className="generator-preview-panel">
                      <div className="content-subline">
                        <div>
                          <p className="section-kicker">Generated worksheet output</p>
                        </div>
                      </div>

                      <div className="preview-block">
                        {status === 'ready' && officePreviewUrl ? (
                          <iframe
                            title="Generated Word preview"
                            className="pdf-frame"
                            src={officePreviewUrl}
                          />
                        ) : status === 'ready' ? (
                          <div className="preview-placeholder">
                            <p>Your premium worksheet is ready to download.</p>
                            <p className="muted">Preview is unavailable right now, but the DOCX output has been generated successfully.</p>
                          </div>
                        ) : status === 'failed' ? (
                          <div className="preview-placeholder error-state">
                            <p>The worksheet job failed before the Word document could be generated.</p>
                            <p className="muted">{error || 'Please check the backend logs and retry the source upload.'}</p>
                          </div>
                        ) : (
                          <div className="preview-placeholder">
                            <p>The worksheet preview will appear here after the source is processed.</p>
                            <p className="muted">
                              The generator reads the uploaded PDF or DOCX, audits the concept scope, and then compiles the final Word worksheet.
                            </p>
                          </div>
                        )}

                        <div className="download-row">
                          {downloadDocxUrl && (
                            <a className="button primary download-button" href={downloadDocxUrl}>
                              Download Word worksheet
                            </a>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </section>
          </main>
        </>
      )}

      <footer className="footer">
        <span>Powered by Spectropy</span>
      </footer>
    </div>
  );
}

export default App;
