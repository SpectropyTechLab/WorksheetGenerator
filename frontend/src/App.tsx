import { useEffect, useMemo, useState } from 'react';
import './App.css';
import UploadForm from './components/UploadForm';
import LoginForm from './components/LoginForm';
import type { WorksheetCreateResponse, WorksheetStatus, WorksheetStatusResponse } from './types';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000';

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
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [docxPreviewUrl, setDocxPreviewUrl] = useState<string | null>(null);
  const [authToken, setAuthToken] = useState<string | null>(
    () => localStorage.getItem('auth_token') || null
  );
  const [authRole, setAuthRole] = useState<string | null>(
    () => localStorage.getItem('auth_role') || null
  );
  const [loginError, setLoginError] = useState<string | null>(null);
  const [adminView, setAdminView] = useState<'users' | 'upload'>('users');
  const [users, setUsers] = useState<Array<{ id: string; username: string; role: string }>>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [userForm, setUserForm] = useState({ username: '', password: '', role: 'user' });
  const [editingUserId, setEditingUserId] = useState<string | null>(null);

  const isAuthenticated = Boolean(authToken);

  const downloadDocxUrl = useMemo(() => {
    if (!worksheetId || status !== 'ready') return null;
    if (!authToken) return null;
    const tokenParam = encodeURIComponent(authToken);
    return `${API_BASE}/api/worksheet/${worksheetId}/docx?token=${tokenParam}`;
  }, [worksheetId, status, authToken]);

  const officePreviewUrl = useMemo(() => {
    if (!docxPreviewUrl) return null;
    return `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(docxPreviewUrl)}`;
  }, [docxPreviewUrl]);

  useEffect(() => {
    if (!worksheetId || !status) return;
    if (status === 'ready' || status === 'failed') return;

    const intervalId = window.setInterval(async () => {
      try {
        const response = await fetch(`${API_BASE}/api/worksheet/${worksheetId}/status`, {
          headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined
        });
        if (!response.ok) {
          const message = await readErrorMessage(response);
          throw new Error(message || 'Failed to fetch status');
        }
        const data = (await response.json()) as WorksheetStatusResponse;
        setStatus(data.status);
        setError(data.status === 'failed' ? data.error || 'Worksheet processing failed' : null);
        if (data.status === 'ready') {
          setDocxPreviewUrl(data.docxUrl || null);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      }
    }, 2500);

    return () => window.clearInterval(intervalId);
  }, [worksheetId, status]);

  useEffect(() => {
    if (!isAuthenticated || authRole !== 'admin' || adminView !== 'users' || !authToken) return;
    const loadUsers = async () => {
      setUsersLoading(true);
      setUsersError(null);
      try {
        const response = await fetch(`${API_BASE}/api/users`, {
          headers: { Authorization: `Bearer ${authToken}` }
        });
        if (!response.ok) {
          const message = await readErrorMessage(response);
          throw new Error(message || 'Failed to load users');
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
  }, [isAuthenticated, authRole, adminView, authToken]);

  const handleSubmit = async (formData: FormData) => {
    setIsSubmitting(true);
    setError(null);
    setDocxPreviewUrl(null);

    try {
      const response = await fetch(`${API_BASE}/api/worksheet`, {
        method: 'POST',
        body: formData,
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined
      });

      if (!response.ok) {
        const message = await readErrorMessage(response);
        throw new Error(message || 'Upload failed');
      }

      const data = (await response.json()) as WorksheetCreateResponse;
      setWorksheetId(data.worksheetId);
      setStatus('extracting');
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
      const message = await readErrorMessage(response);
      setLoginError(message || 'Login failed');
      return;
    }
    const data = (await response.json()) as {
      token: string;
      user: { username: string; role: string };
    };
    setAuthToken(data.token);
    setAuthRole(data.user.role);
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
      const message = await readErrorMessage(response);
      setUsersError(message || 'Failed to create user');
      return;
    }
    setUserForm({ username: '', password: '', role: 'user' });
    setEditingUserId(null);
    const data = (await response.json()) as { user: { id: string; username: string; role: string } };
    setUsers((prev) => [data.user, ...prev]);
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
      const message = await readErrorMessage(response);
      setUsersError(message || 'Failed to update user');
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
      const message = await readErrorMessage(response);
      setUsersError(message || 'Failed to delete user');
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
      <header className="hero">
        <div className="hero-inner">
          <div className="hero-header">
            <h1 className="pill">TLM Generator</h1>
            <div className="hero-copy">
              <h2 className="hero-title">Convert worksheets into polished manuals.</h2>
              <p className="hero-subtitle">
                Upload a worksheet, select your Program, Subject, Chapter and let SPECTROPY-RAW AI generate a Word manual ready to download.
              </p>
            </div>
          </div>
        </div>
      </header>

      <main className={`content ${isAuthenticated ? 'split-layout' : ''}`}>
        {!isAuthenticated ? (
          <section className="panel full-panel">
            <div className="panel-header">
              <h2>Sign in</h2>
            </div>
            <LoginForm onLogin={handleLogin} error={loginError} />
          </section>
        ) : (
          <section className="panel left-panel">
            <div className="panel-header">
              <h2>{authRole === 'admin' ? 'Admin' : 'Upload worksheet'}</h2>
              <button className="button" type="button" onClick={handleLogout}>
                Sign out
              </button>
            </div>
            {authRole === 'admin' && (
              <div className="panel-tabs">
                <button
                  className={`panel-tab ${adminView === 'users' ? 'active' : ''}`}
                  type="button"
                  onClick={() => setAdminView('users')}
                >
                  User access control
                </button>
                <button
                  className={`panel-tab ${adminView === 'upload' ? 'active' : ''}`}
                  type="button"
                  onClick={() => setAdminView('upload')}
                >
                  Worksheet upload
                </button>
              </div>
            )}
            {authRole === 'admin' ? (
              adminView === 'upload' ? (
                <UploadForm onSubmit={handleSubmit} isSubmitting={isSubmitting} />
              ) : (
                <>
                  <div className="field-grid">
                    <label className="field">
                      <span>Email</span>
                      <input
                        type="email"
                        value={userForm.username}
                        onChange={(event) =>
                          setUserForm((prev) => ({ ...prev, username: event.target.value }))
                        }
                      />
                    </label>
                    <label className="field">
                      <span>Password</span>
                      <input
                        type="text"
                        value={userForm.password}
                        onChange={(event) =>
                          setUserForm((prev) => ({ ...prev, password: event.target.value }))
                        }
                      />
                    </label>
                    <label className="field">
                      <span>Role</span>
                      <select
                        value={userForm.role}
                        onChange={(event) =>
                          setUserForm((prev) => ({
                            ...prev,
                            role: event.target.value as 'admin' | 'user'
                          }))
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
                        <button className="button" type="button" onClick={cancelUserEdit}>
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
                </>
              )
            ) : (
              <UploadForm onSubmit={handleSubmit} isSubmitting={isSubmitting} />
            )}
          </section>
        )}

        {isAuthenticated && (
          <section className="panel right-panel">
            {authRole === 'admin' && adminView === 'users' ? (
              <>
                <div className="preview-header">
                  <h2>Existing users</h2>
                </div>
                {usersError && <p className="form-error">{usersError}</p>}
                {usersLoading ? (
                  <p className="muted">Loading users…</p>
                ) : (
                  <div className="status-steps">
                    {users.map((user) => (
                      <div key={user.id} className="status-step">
                        <div className="step-badge">{user.role === 'admin' ? 'A' : 'U'}</div>
                        <div>
                          <h4>{user.username}</h4>
                          <p className="muted">Role: {user.role}</p>
                        </div>
                        <div className="admin-row-actions">
                          <button className="button" type="button" onClick={() => startUserEdit(user)}>
                            Edit
                          </button>
                          <button className="button" type="button" onClick={() => handleUserDelete(user.id)}>
                            Delete
                          </button>
                        </div>
                      </div>
                    ))}
                    {!users.length && <p className="muted">No users yet.</p>}
                  </div>
                )}
              </>
            ) : (
            <>
              <div className="preview-header">
                <h2>Word preview</h2>
                <span className="preview-status">
                  Job status: {status ?? 'not started'}
                </span>
              </div>
              <div className="preview-block">
                {status === 'ready' && officePreviewUrl ? (
                  <iframe
                    title="Generated Word preview"
                    className="pdf-frame"
                    src={officePreviewUrl}
                    style={{ height: '60vh' }}
                  />
                ) : status === 'ready' ? (
                  <div className="preview-placeholder">
                    <p>Your Word manual is ready to download.</p>
                    <p className="muted">Preview is unavailable, but the DOCX file is ready below.</p>
                  </div>
                ) : status === 'failed' ? (
                  <div className="preview-placeholder">
                    <p>The job failed before the Word manual could be generated.</p>
                    <p className="muted">{error || 'Please retry after checking the backend error details.'}</p>
                  </div>
                ) : (
                  <div className="preview-placeholder">
                    <p>Your Word manual will be available here once the job is ready.</p>
                    <p className="muted">Upload a worksheet to start the process.</p>
                  </div>
                )}
                <div className="download-row">
                  {downloadDocxUrl && (
                    <a className="button primary download-button" href={downloadDocxUrl}>
                      Download Word
                    </a>
                  )}
                </div>
              </div>
            </>
          )}
        </section>
        )}
      </main>

      <footer className="footer">
        <span>Powered by SPECTROPY-RAW AI</span>
        <span>Output: Word</span>
      </footer>
    </div>
  );
}

export default App;
