
/**
 * SINUS VIEWER — REACT APPLICATION SHELL
 * ======================================
 *
 * Responsibilities:
 * - Browser routing for authentication and viewer pages.
 * - Session verification using the protected backend API.
 * - Login and logout with HttpOnly cookie authentication.
 * - Protected route handling.
 * - Loading, signed-out and error states.
 * - Main workspace navigation.
 * - Accessibility-friendly forms and status messages.
 *
 * Security:
 * - No token is read from document.cookie.
 * - No credential or patient data is saved in storage.
 * - All API calls use same-origin relative URLs.
 * - Authentication requires successful server verification.
 * - No raw server errors or request URLs are displayed.
 * - Route guards improve UX but do not replace API auth.
 * - No source DICOM files are touched here.
 *
 * Dependencies:
 * - React 18
 * - React Router v6
 * - Backend endpoints from api/routes/auth.py
 *
 * The MPR/3D viewer will replace the placeholder workspace
 * in later frontend files.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import {
  Link,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { AppShell } from "./components/layout/AppShell";


// ============================================================
// 01 — TYPES
// ============================================================

type AuthStatus =
  | "checking"
  | "authenticated"
  | "unauthenticated";

interface SessionInfo {
  readonly authenticated: true;
  readonly expires_at: number;
}

interface LoginPayload {
  readonly username: string;
  readonly password: string;
}

interface LoginResult {
  readonly success: true;
  readonly session: SessionInfo;
}

interface AuthContextValue {
  readonly status: AuthStatus;
  readonly session: SessionInfo | null;
  readonly login: (
    payload: LoginPayload,
  ) => Promise<boolean>;
  readonly logout: () => Promise<void>;
  readonly refreshSession: () => Promise<void>;
}

type LoginState =
  | "idle"
  | "submitting"
  | "failed";


// ============================================================
// 02 — API CONSTANTS
// ============================================================

const AUTH_API = {
  login: "/api/auth/login",
  logout: "/api/auth/logout",
  session: "/api/auth/session",
} as const;

const REQUEST_TIMEOUT_MS = 15000;

const MAX_USERNAME_LENGTH = 128;
const MAX_PASSWORD_LENGTH = 1024;

const GENERIC_LOGIN_ERROR =
  "Unable to sign in. Check your credentials and try again.";

const GENERIC_CONNECTION_ERROR =
  "The server could not be reached. Please try again.";

const NO_STORE_HEADERS = {
  Accept: "application/json",
} as const;


// ============================================================
// 03 — SAFE API UTILITIES
// ============================================================

function isSessionInfo(
  value: unknown,
): value is SessionInfo {
  if (
    typeof value !== "object" ||
    value === null
  ) {
    return false;
  }

  const candidate = value as Record<
    string,
    unknown
  >;

  return (
    candidate.authenticated === true &&
    typeof candidate.expires_at === "number" &&
    Number.isFinite(candidate.expires_at) &&
    candidate.expires_at > 0
  );
}


function isLoginResult(
  value: unknown,
): value is LoginResult {
  if (
    typeof value !== "object" ||
    value === null
  ) {
    return false;
  }

  const candidate = value as Record<
    string,
    unknown
  >;

  return (
    candidate.success === true &&
    isSessionInfo(candidate.session)
  );
}


/**
 * Bound all authentication API response bodies.
 *
 * Successful responses contain only a small session
 * envelope. Never parse unlimited server responses.
 */
async function readSmallJSON(
  response: Response,
): Promise<unknown> {
  const MAX_RESPONSE_BYTES = 8192;

  if (!response.body) {
    return null;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const result = await reader.read();

      if (result.done) {
        break;
      }

      total += result.value.byteLength;

      if (total > MAX_RESPONSE_BYTES) {
        throw new Error(
          "Authentication response too large.",
        );
      }

      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return JSON.parse(
    new TextDecoder().decode(bytes),
  ) as unknown;
}


/**
 * Cookie handling is delegated entirely to the browser.
 *
 * credentials:"include" allows the HttpOnly session
 * cookie to accompany same-origin requests.
 */
async function authFetch(
  endpoint: string,
  options: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController();

  const timeout = window.setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS,
  );

  try {
    return await fetch(endpoint, {
      ...options,
      credentials: "include",
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
      headers: {
        ...NO_STORE_HEADERS,
        ...options.headers,
      },
    });
  } finally {
    window.clearTimeout(timeout);
  }
}


// ============================================================
// 04 — AUTH CONTEXT
// ============================================================

const AuthContext = createContext<
  AuthContextValue | undefined
>(undefined);


function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error(
      "Authentication provider unavailable.",
    );
  }

  return context;
}


// ============================================================
// 05 — AUTH PROVIDER
// ============================================================

function AuthProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [status, setStatus] =
    useState<AuthStatus>("checking");

  const [session, setSession] =
    useState<SessionInfo | null>(null);

  /**
   * Validate the cookie against the backend.
   *
   * A successful HTTP response alone is not enough:
   * the returned session schema must also be valid.
   */
  const refreshSession = useCallback(
    async (): Promise<void> => {
      setStatus("checking");

      try {
        const response = await authFetch(
          AUTH_API.session,
        );

        if (!response.ok) {
          setSession(null);
          setStatus("unauthenticated");
          return;
        }

        const payload = await readSmallJSON(
          response,
        );

        if (!isSessionInfo(payload)) {
          setSession(null);
          setStatus("unauthenticated");
          return;
        }

        setSession(payload);
        setStatus("authenticated");
      } catch {
        setSession(null);
        setStatus("unauthenticated");
      }
    },
    [],
  );

  /**
   * Check the server session when the app starts.
   *
   * React StrictMode may run development effects twice.
   * Both checks are harmless, but the backend must
   * support concurrent authenticated GET requests.
   */
  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  const login = useCallback(
    async (
      payload: LoginPayload,
    ): Promise<boolean> => {
      try {
        const response = await authFetch(
          AUTH_API.login,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
          },
        );

        if (!response.ok) {
          setSession(null);
          setStatus("unauthenticated");
          return false;
        }

        const result = await readSmallJSON(
          response,
        );

        if (!isLoginResult(result)) {
          setSession(null);
          setStatus("unauthenticated");
          return false;
        }

        /**
         * Explicitly verify the newly issued cookie
         * using the backend's session endpoint.
         */
        const verification = await authFetch(
          AUTH_API.session,
        );

        if (!verification.ok) {
          setSession(null);
          setStatus("unauthenticated");
          return false;
        }

        const verifiedSession =
          await readSmallJSON(verification);

        if (!isSessionInfo(verifiedSession)) {
          setSession(null);
          setStatus("unauthenticated");
          return false;
        }

        setSession(verifiedSession);
        setStatus("authenticated");
        return true;
      } catch {
        setSession(null);
        setStatus("unauthenticated");
        return false;
      }
    },
    [],
  );

  /**
   * Clear local authenticated UI state immediately.
   *
   * Server revocation is authoritative; if the request
   * fails, the server-side cookie may still be valid.
   * The UI must therefore display a generic failure
   * and should not claim successful server revocation.
   */
  const logout = useCallback(
    async (): Promise<void> => {
      setSession(null);
      setStatus("unauthenticated");

      let response: Response;

      try {
        response = await authFetch(
          AUTH_API.logout,
          {
            method: "POST",
          },
        );
      } catch {
        throw new Error(
          GENERIC_CONNECTION_ERROR,
        );
      }

      if (!response.ok) {
        throw new Error(
          "Sign-out could not be confirmed by the server.",
        );
      }
    },
    [],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      session,
      login,
      logout,
      refreshSession,
    }),
    [
      status,
      session,
      login,
      logout,
      refreshSession,
    ],
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}


// ============================================================
// 06 — LOADING SCREEN
// ============================================================

function LoadingScreen() {
  return (
    <main
      className="flex min-h-screen items-center
        justify-center bg-slate-950 px-6
        text-slate-100"
      role="status"
      aria-live="polite"
    >
      <div className="text-center">
        <div
          className="mx-auto mb-5 h-10 w-10
            animate-spin rounded-full border-4
            border-slate-700 border-t-cyan-400"
          aria-hidden="true"
        />

        <h1 className="text-lg font-semibold">
          Sinus Viewer
        </h1>

        <p className="mt-2 text-sm text-slate-400">
          Verifying your session...
        </p>
      </div>
    </main>
  );
}


// ============================================================
// 07 — PROTECTED ROUTE
// ============================================================

function ProtectedRoute() {
  const { status } = useAuth();
  const location = useLocation();

  if (status === "checking") {
    return <LoadingScreen />;
  }

  if (status !== "authenticated") {
    return (
      <Navigate
        to="/login"
        replace
        state={{
          from: location.pathname,
        }}
      />
    );
  }

  return <Outlet />;
}


// ============================================================
// 08 — LOGIN PAGE
// ============================================================

function LoginPage() {
  const {
    status,
    login,
  } = useAuth();

  const navigate = useNavigate();

  const [username, setUsername] =
    useState("");

  const [password, setPassword] =
    useState("");

  const [loginState, setLoginState] =
    useState<LoginState>("idle");

  const location = useLocation();

  if (status === "checking") {
    return <LoadingScreen />;
  }

  if (status === "authenticated") {
    return (
      <Navigate
        to="/viewer"
        replace
      />
    );
  }

  const submitting =
    loginState === "submitting";

  async function handleSubmit(
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();

    if (submitting) {
      return;
    }

    if (
      username.length < 1 ||
      username.length > MAX_USERNAME_LENGTH ||
      password.length < 1 ||
      password.length > MAX_PASSWORD_LENGTH
    ) {
      setLoginState("failed");
      return;
    }

    setLoginState("submitting");

    const success = await login({
      username,
      password,
    });

    setPassword("");

    if (success) {
      const state = location.state as
        | { from?: unknown }
        | null;

      const destination =
        typeof state?.from === "string" &&
        state.from.startsWith("/") &&
        !state.from.startsWith("//") &&
        !state.from.startsWith("/login")
          ? state.from
          : "/viewer";

      navigate(destination, {
        replace: true,
      });
    } else {
      setLoginState("failed");
    }
  }

  return (
    <main
      className="flex min-h-screen items-center
        justify-center bg-slate-950 px-4
        text-slate-100"
    >
      <section
        className="w-full max-w-md rounded-2xl
          border border-slate-800 bg-slate-900
          p-8 shadow-2xl"
        aria-labelledby="login-title"
      >
        <div
          className="mb-6 flex h-12 w-12
            items-center justify-center rounded-xl
            bg-cyan-500/10 text-cyan-300"
          aria-hidden="true"
        >
          <span className="text-xl font-bold">
            SV
          </span>
        </div>

        <h1
          id="login-title"
          className="text-2xl font-semibold"
        >
          Sinus Viewer
        </h1>

        <p className="mt-2 text-sm text-slate-400">
          Sign in to access the medical imaging
          workspace.
        </p>

        <form
          className="mt-7 space-y-5"
          onSubmit={(event) => {
            void handleSubmit(event);
          }}
        >
          <div>
            <label
              htmlFor="username"
              className="mb-2 block text-sm
                font-medium text-slate-200"
            >
              Username
            </label>

            <input
              id="username"
              type="text"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              maxLength={MAX_USERNAME_LENGTH}
              disabled={submitting}
              value={username}
              onChange={(event) => {
                setUsername(event.target.value);
              }}
              className="w-full rounded-lg border
                border-slate-700 bg-slate-950
                px-3 py-3 text-slate-100
                outline-none focus:border-cyan-400"
            />
          </div>

          <div>
            <label
              htmlFor="password"
              className="mb-2 block text-sm
                font-medium text-slate-200"
            >
              Password
            </label>

            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={MAX_PASSWORD_LENGTH}
              disabled={submitting}
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
              className="w-full rounded-lg border
                border-slate-700 bg-slate-950
                px-3 py-3 text-slate-100
                outline-none focus:border-cyan-400"
            />
          </div>

          {loginState === "failed" && (
            <p
              role="alert"
              className="rounded-lg border
                border-red-800 bg-red-950/40
                p-3 text-sm text-red-200"
            >
              {GENERIC_LOGIN_ERROR}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg
              bg-cyan-500 px-4 py-3
              font-semibold text-slate-950
              hover:bg-cyan-400
              disabled:cursor-not-allowed
              disabled:opacity-50"
          >
            {submitting
              ? "Signing in..."
              : "Sign in"}
          </button>
        </form>

        <p className="mt-7 text-xs text-slate-500">
          Authorized access only.
          Medical images require appropriate
          privacy safeguards.
        </p>
      </section>
    </main>
  );
}


// ============================================================
// 09 — AUTHENTICATED APPLICATION SHELL
// ============================================================

function ApplicationShell() {
  const { logout } = useAuth();
  const navigate = useNavigate();

  const [logoutError, setLogoutError] =
    useState<string | null>(null);

  async function handleLogout(): Promise<void> {
    setLogoutError(null);

    try {
      await logout();

      navigate("/login", {
        replace: true,
      });
    } catch {
      setLogoutError(
        "Server sign-out could not be confirmed. " +
        "Close this browser session and contact " +
        "the system operator if necessary.",
      );
    }
  }

  return (
    <div
      className="flex min-h-screen flex-col
        bg-slate-950 text-slate-100"
    >
      <header
        className="flex flex-wrap items-center
          justify-between gap-4 border-b
          border-slate-800 bg-slate-900
          px-5 py-4"
      >
        <div>
          <h1 className="text-lg font-bold">
            Sinus Viewer
          </h1>
          <p className="text-xs text-slate-400">
            CT / CBCT Imaging Workspace
          </p>
        </div>

        <nav
          aria-label="Primary navigation"
          className="flex items-center gap-4"
        >
          <Link
            to="/viewer"
            className="text-sm text-slate-200
              hover:text-cyan-300"
          >
            Viewer
          </Link>

          <Link
            to="/settings"
            className="text-sm text-slate-200
              hover:text-cyan-300"
          >
            Settings
          </Link>

          <button
            type="button"
            onClick={() => {
              void handleLogout();
            }}
            className="rounded-lg border
              border-slate-700 px-3 py-2
              text-sm hover:bg-slate-800"
          >
            Sign out
          </button>
        </nav>
      </header>

      {logoutError && (
        <div
          role="alert"
          className="border-b border-amber-800
            bg-amber-950/40 px-5 py-3
            text-sm text-amber-200"
        >
          {logoutError}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <Outlet />
      </div>

      <footer
        className="border-t border-slate-800
          bg-slate-900 px-5 py-2
          text-xs text-slate-500"
      >
        Sinus Viewer — Research and
        visualization environment
      </footer>
    </div>
  );
}


// ============================================================
// 10 — VIEWER WORKSPACE PLACEHOLDER
// ============================================================

function ViewerPage() {
  const {
    status,
    logout,
    refreshSession,
  } = useAuth();
  const sessionStatus =
    status === "authenticated"
      ? "authenticated"
      : "authentication-required";
  return (
    <AppShell
      sessionStatus={sessionStatus}
      adaptVolume={(loaded) => ({
        voxels: loaded.voxels,
        shapeZYX: loaded.shapeZYX,
        geometry: loaded.geometry,
      })}
      onSignOut={logout}
      onAuthenticationRequired={() => {
        void refreshSession();
      }}
    />
  );
}


// ============================================================
// 11 — SETTINGS PLACEHOLDER
// ============================================================

function SettingsPage() {
  const { session } = useAuth();

  return (
    <main className="w-full px-6 py-8">
      <h2 className="text-2xl font-semibold">
        Application Settings
      </h2>

      <p className="mt-3 text-sm text-slate-400">
        Display preferences and viewer controls
        will be implemented in later files.
      </p>

      <div
        className="mt-6 max-w-lg rounded-xl
          border border-slate-800 bg-slate-900 p-5"
      >
        <h3 className="font-medium">
          Authentication
        </h3>

        <p className="mt-2 text-sm text-slate-400">
          {session?.authenticated
            ? "Server session verified"
            : "Not authenticated"}
        </p>
      </div>
    </main>
  );
}


// ============================================================
// 12 — NOT FOUND
// ============================================================

function NotFoundPage() {
  return (
    <main
      className="flex min-h-screen flex-col
        items-center justify-center
        bg-slate-950 px-6 text-center
        text-slate-100"
    >
      <h1 className="text-4xl font-bold">
        404
      </h1>

      <p className="mt-3 text-slate-400">
        This page is unavailable.
      </p>

      <Link
        to="/viewer"
        className="mt-6 rounded-lg
          bg-cyan-500 px-5 py-3
          font-medium text-slate-950"
      >
        Return to viewer
      </Link>
    </main>
  );
}


// ============================================================
// 13 — ROUTE CONFIGURATION
// ============================================================

function ApplicationRoutes() {
  return (
    <Routes>
      <Route
        path="/login"
        element={<LoginPage />}
      />

      <Route element={<ProtectedRoute />}>
        <Route
          path="/viewer"
          element={<ViewerPage />}
        />
        <Route
          element={<ApplicationShell />}
        >
          <Route
            path="/"
            element={
              <Navigate
                to="/viewer"
                replace
              />
            }
          />


          <Route
            path="/settings"
            element={<SettingsPage />}
          />
        </Route>
      </Route>

      <Route
        path="/404"
        element={<NotFoundPage />}
      />

      <Route
        path="*"
        element={<NotFoundPage />}
      />
    </Routes>
  );
}


// ============================================================
// 14 — APPLICATION EXPORT
// ============================================================

export default function App() {
  return (
    <AuthProvider>
      <ApplicationRoutes />
    </AuthProvider>
  );
}


// ============================================================
// END OF SINUS VIEWER APPLICATION SHELL
// ============================================================
