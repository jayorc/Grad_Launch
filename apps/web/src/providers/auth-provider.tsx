"use client";

import type { AuthResponse, LoginInput, RegisterInput, StudentProfile, UpdateProfileInput, UserSession } from "@gradlaunch/shared";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { getSession, login, logout, register, updateProfile } from "../lib/api";

type AuthContextValue = {
  student: StudentProfile | null;
  session: UserSession | null;
  loading: boolean;
  isAuthenticated: boolean;
  loginUser: (input: LoginInput) => Promise<void>;
  registerUser: (input: RegisterInput) => Promise<void>;
  logoutUser: () => Promise<void>;
  saveProfile: (input: UpdateProfileInput) => Promise<void>;
  refreshSession: () => Promise<void>;
};

const SESSION_STORAGE_KEY = "gradlaunch_session_token";

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [student, setStudent] = useState<StudentProfile | null>(null);
  const [session, setSession] = useState<UserSession | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = window.sessionStorage.getItem(SESSION_STORAGE_KEY);

    if (!token) {
      setLoading(false);
      return;
    }

    getSession(token)
      .then((result) => {
        hydrateAuth(result);
      })
      .catch(() => {
        window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
        setStudent(null);
        setSession(null);
      })
      .finally(() => setLoading(false));
  }, []);

  async function loginUser(input: LoginInput) {
    const result = await login(input);
    hydrateAuth(result);
  }

  async function registerUser(input: RegisterInput) {
    const result = await register(input);
    hydrateAuth(result);
  }

  async function logoutUser() {
    if (session?.token) {
      await logout(session.token);
    }

    window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
    setStudent(null);
    setSession(null);
  }

  async function saveProfile(input: UpdateProfileInput) {
    if (!student || !session?.token) {
      throw new Error("No authenticated user.");
    }

    const updatedStudent = await updateProfile(session.token, input);
    setStudent(updatedStudent);
  }

  async function refreshSession() {
    if (!session?.token) {
      throw new Error("No authenticated user.");
    }

    const result = await getSession(session.token);
    hydrateAuth(result);
  }

  function hydrateAuth(result: AuthResponse) {
    setStudent(result.student);
    setSession(result.session);
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, result.session.token);
  }

  return (
    <AuthContext.Provider
      value={{
        student,
        session,
        loading,
        isAuthenticated: Boolean(student && session),
        loginUser,
        registerUser,
        logoutUser,
        saveProfile,
        refreshSession
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error("useAuth must be used within AuthProvider.");
  }

  return context;
}
