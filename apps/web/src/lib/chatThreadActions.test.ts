import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type ModelSelection,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  defaultNewThreadProjectRef,
  resolveNewThreadModelSelectionOverride,
  resolveThreadActionProjectRef,
  scopeThreadActionContext,
  type ChatThreadActionContext,
} from "./chatThreadActions";

const PROJECT_DEFAULT_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "project-default",
};
const CARRIED_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "carried-model",
};

describe("chatThreadActions", () => {
  it("does not carry a non-explicit model from the destination draft back into itself", () => {
    expect(
      resolveNewThreadModelSelectionOverride({
        projectDefaultSelection: null,
        carrySelection: CARRIED_SELECTION,
        carrySourceDraftId: "draft-a",
        destinationDraftId: "draft-a",
      }),
    ).toBeNull();
  });

  it("keeps the project default above any carried selection", () => {
    expect(
      resolveNewThreadModelSelectionOverride({
        projectDefaultSelection: PROJECT_DEFAULT_SELECTION,
        carrySelection: CARRIED_SELECTION,
        carrySourceDraftId: "draft-a",
        destinationDraftId: "draft-b",
      }),
    ).toEqual(PROJECT_DEFAULT_SELECTION);
  });

  it("never picks Home's folder as the default project", () => {
    const home = { environmentId: ENVIRONMENT_ID, id: PROJECT_ID, workspaceRoot: "/data/home" };
    const app = {
      environmentId: ENVIRONMENT_ID,
      id: FALLBACK_PROJECT_ID,
      workspaceRoot: "/code/app",
    };
    const options = { primaryEnvironmentId: ENVIRONMENT_ID, homeWorkspaceRoot: "/data/home" };
    expect(defaultNewThreadProjectRef([home, app], options)).toEqual(
      scopeProjectRef(ENVIRONMENT_ID, FALLBACK_PROJECT_ID),
    );
    expect(defaultNewThreadProjectRef([home], options)).toBeNull();
  });

  it("never starts a new thread in Home's folder from Home's draft before its shell loads", () => {
    const projectRef = resolveThreadActionProjectRef(
      createContext({
        activeDraftThread: {
          threadId: "home:current",
          environmentId: ENVIRONMENT_ID,
          projectId: PROJECT_ID,
        },
      }),
    );

    expect(projectRef).toEqual(scopeProjectRef(ENVIRONMENT_ID, FALLBACK_PROJECT_ID));
  });

  it("never starts a new thread in Home's folder from Home", () => {
    const projectRef = resolveThreadActionProjectRef(
      createContext({
        activeThread: { id: "home:current", environmentId: ENVIRONMENT_ID, projectId: PROJECT_ID },
        activeDraftThread: { environmentId: ENVIRONMENT_ID, projectId: PROJECT_ID },
      }),
    );

    expect(projectRef).toEqual(scopeProjectRef(ENVIRONMENT_ID, FALLBACK_PROJECT_ID));
  });
});

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const PROJECT_ID = ProjectId.make("project-1");
const FALLBACK_PROJECT_ID = ProjectId.make("project-2");

function createContext(overrides: Partial<ChatThreadActionContext> = {}): ChatThreadActionContext {
  return {
    activeDraftThread: null,
    activeThread: undefined,
    defaultProjectRef: scopeProjectRef(ENVIRONMENT_ID, FALLBACK_PROJECT_ID),
    handleNewThread: async () => {},
    ...overrides,
  };
}

describe("scopeThreadActionContext", () => {
  const workEnvironmentId = EnvironmentId.make("environment-work");
  const homeProjectRef = scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID);

  it("keeps a new thread off machines the sidebar hides", () => {
    const scoped = scopeThreadActionContext(
      createContext({
        activeThread: { environmentId: workEnvironmentId, projectId: PROJECT_ID },
        activeDraftThread: { environmentId: workEnvironmentId, projectId: PROJECT_ID },
        defaultProjectRef: scopeProjectRef(workEnvironmentId, FALLBACK_PROJECT_ID),
      }),
      ENVIRONMENT_ID,
      homeProjectRef,
    );

    expect(resolveThreadActionProjectRef(scoped)).toEqual(homeProjectRef);
  });

  it("keeps context from the filtered machine and leaves an unfiltered one alone", () => {
    const context = createContext({
      activeThread: { environmentId: ENVIRONMENT_ID, projectId: PROJECT_ID },
    });

    expect(
      resolveThreadActionProjectRef(scopeThreadActionContext(context, ENVIRONMENT_ID, null)),
    ).toEqual(homeProjectRef);
    expect(scopeThreadActionContext(context, null, null)).toBe(context);
  });
});
