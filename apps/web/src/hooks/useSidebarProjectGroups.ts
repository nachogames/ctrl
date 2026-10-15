import { useMemo } from "react";

import { orderItemsByPreferredIds } from "../components/Sidebar.logic";
import { getProjectOrderKey, selectProjectGroupingSettings } from "../logicalProject";
import { buildSidebarProjectSnapshots } from "../sidebarProjectGrouping";
import { useEnvironmentIdentities, usePrimaryEnvironmentId } from "../state/environments";
import { useProjects } from "../state/entities";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../uiStateStore";
import { useClientSettings } from "./useSettings";

/**
 * Ctrl's sidebar project order: the manual order, matching projects saved
 * under their old cwd key too. The sidebar and the PR filter both use it.
 */
export function orderSidebarProjects<Project extends Parameters<typeof getProjectOrderKey>[0]>(
  projects: ReadonlyArray<Project>,
  projectOrder: ReadonlyArray<string>,
): Project[] {
  return orderItemsByPreferredIds({
    items: projects,
    preferredIds: projectOrder,
    getId: getProjectOrderKey,
    getPreferenceIds: (project) => [
      getProjectOrderKey(project),
      legacyProjectCwdPreferenceKey(project.workspaceRoot),
    ],
  });
}

/**
 * The sidebar's project groups, in the order the sidebar shows them.
 * Ctrl: the sidebar always uses the manual project order (no sort setting),
 * so this mirrors that instead of upstream's sorted order.
 */
export function useSidebarProjectGroups() {
  const projects = useProjects();
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);
  const environments = useEnvironmentIdentities();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const orderedProjects = useMemo(
    () => orderSidebarProjects(projects, projectOrder),
    [projectOrder, projects],
  );
  return useMemo(() => {
    const labels = new Map(
      environments.map((environment) => [environment.environmentId, environment.label] as const),
    );
    return buildSidebarProjectSnapshots({
      projects: orderedProjects,
      groupScratchProjects: true,
      settings: groupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: (environmentId) => labels.get(environmentId) ?? null,
    });
  }, [environments, groupingSettings, orderedProjects, primaryEnvironmentId]);
}
