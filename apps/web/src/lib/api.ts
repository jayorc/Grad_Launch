import type {
  Application,
  ApplicationRun,
  AgentCapabilities,
  AuthResponse,
  CreateApplicationResult,
  DashboardReport,
  Job,
  LoginInput,
  MatchStrictness,
  RegisterInput,
  ResumeDraftResponse,
  SearchSessionResult,
  SubmitApplicationInput,
  SubmitApplicationResult,
  StudentProfile,
  UpdateProfileInput
} from "@gradlaunch/shared";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const isFormData = typeof FormData !== "undefined" && init?.body instanceof FormData;
  const requestUrl = `${API_BASE_URL}${path}`;
  let response: Response;

  try {
    response = await fetch(requestUrl, {
      ...init,
      headers: {
        ...(isFormData ? {} : { "Content-Type": "application/json" }),
        ...(init?.headers ?? {})
      },
      cache: "no-store"
    });
  } catch (error) {
    throw new Error(buildNetworkErrorMessage(requestUrl, error));
  }

  const body = await parseBody(response);

  if (!response.ok) {
    throw new Error(extractErrorMessage(body, path));
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return body as T;
}

function authHeaders(token?: string): HeadersInit {
  return token
    ? {
        Authorization: `Bearer ${token}`
      }
    : {};
}

export function getStudents() {
  return request<StudentProfile[]>("/students");
}

export function getCurrentStudent(token: string) {
  return request<StudentProfile>("/students/me", {
    headers: authHeaders(token)
  });
}

export function getDashboard(token: string) {
  return request<DashboardReport>("/students/me/dashboard", {
    headers: authHeaders(token)
  });
}

export function getApplications(token: string) {
  return request<Application[]>("/applications", {
    headers: authHeaders(token)
  });
}

export function getApplicationRuns(token: string, applicationId: string) {
  return request<ApplicationRun[]>(`/applications/${applicationId}/runs`, {
    headers: authHeaders(token)
  });
}

export function getJobs(token: string) {
  return request<Job[]>("/jobs", {
    headers: authHeaders(token)
  });
}

export function getAgentCapabilities(token: string) {
  return request<AgentCapabilities>("/agent/capabilities", {
    headers: authHeaders(token)
  });
}

export function startSearchSession(token: string, strictness: MatchStrictness, durationMinutes: number) {
  return request<SearchSessionResult>("/search-sessions", {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ strictness, durationMinutes })
  });
}

export function login(input: LoginInput) {
  return request<AuthResponse>("/auth/login", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function register(input: RegisterInput) {
  return request<AuthResponse>("/auth/register", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function getSession(token: string) {
  return request<AuthResponse>("/auth/session", {
    headers: authHeaders(token)
  });
}

export function logout(token: string) {
  return request<void>("/auth/logout", {
    method: "POST",
    headers: authHeaders(token)
  });
}

export function updateProfile(token: string, input: UpdateProfileInput) {
  return request<StudentProfile>("/students/me/profile", {
    method: "PUT",
    headers: authHeaders(token),
    body: JSON.stringify(input)
  });
}

export function intakeJobUrl(token: string, jobUrl: string) {
  return request<Job>("/jobs/intake-url", {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ jobUrl })
  });
}

export function createApplication(token: string, jobId: string, mode: "draft" | "autofill" | "autopilot") {
  return request<CreateApplicationResult>("/applications", {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ jobId, mode })
  });
}

export function fillJobInBrowser(token: string, jobId: string, submit = false) {
  return request<CreateApplicationResult>(`/jobs/${jobId}/fill-browser`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ submit })
  });
}

export function resumeApplicationInBrowser(token: string, applicationId: string, submit = false) {
  return request<CreateApplicationResult>(`/applications/${applicationId}/resume-browser`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ submit })
  });
}

export function submitApplication(
  token: string,
  applicationId: string,
  input: Omit<SubmitApplicationInput, "applicationId" | "studentId">
) {
  return request<SubmitApplicationResult>(`/applications/${applicationId}/submit`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(input)
  });
}

export function parseResumeDraft(file: File) {
  const formData = new FormData();
  formData.append("resume", file);

  return request<ResumeDraftResponse>("/auth/resume-draft", {
    method: "POST",
    body: formData
  });
}

export function uploadStudentResume(token: string, file: File) {
  const formData = new FormData();
  formData.append("resume", file);

  return request<ResumeDraftResponse>("/students/me/resume", {
    method: "POST",
    headers: authHeaders(token),
    body: formData
  });
}

async function parseBody(response: Response) {
  if (response.status === 204) {
    return undefined;
  }

  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    try {
      return await response.json();
    } catch (_error) {
      return undefined;
    }
  }

  try {
    return await response.text();
  } catch (_error) {
    return undefined;
  }
}

function extractErrorMessage(body: unknown, path: string) {
  if (body && typeof body === "object" && "message" in body && typeof body.message === "string") {
    return body.message;
  }

  if (typeof body === "string" && body.trim().length > 0) {
    return body;
  }

  return `Request failed for ${path}`;
}

function buildNetworkErrorMessage(requestUrl: string, error: unknown) {
  const detail = error instanceof Error && error.message ? ` (${error.message})` : "";
  return `Could not reach the GradLaunch API at ${requestUrl}. Start the API server and verify the Next.js API proxy configuration.${detail}`;
}
