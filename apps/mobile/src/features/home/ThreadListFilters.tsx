import type { ReactNode } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { SymbolView } from "../../components/AppSymbol";
import { ListFilterChip, ListFilterMenu } from "../workspace/ListFilterMenu";
import type { HomeHeaderProps } from "./HomeHeader.types";

export type ProjectChipIndicator = "attention" | "working";

type ProjectChipProps = Pick<
  HomeHeaderProps,
  "projects" | "selectedProjectKey" | "onProjectChange"
> & {
  readonly indicatorByProjectKey?: ReadonlyMap<string, ProjectChipIndicator>;
  /** Pinned to the right of the scrolling chips, such as the Edit button. */
  readonly trailing?: ReactNode;
};

function ProjectChips(props: ProjectChipProps) {
  return (
    <>
      <ListFilterChip
        label="All"
        accessibilityLabel="Show threads from every project"
        active={props.selectedProjectKey === null}
        onPress={() => props.onProjectChange(null)}
      />
      {props.projects.map((project) => (
        <ListFilterChip
          key={project.key}
          label={project.label}
          active={project.key === props.selectedProjectKey}
          indicator={props.indicatorByProjectKey?.get(project.key) ?? null}
          onPress={() =>
            props.onProjectChange(project.key === props.selectedProjectKey ? null : project.key)
          }
        />
      ))}
    </>
  );
}

const ROW_STYLE = { paddingHorizontal: 16, paddingTop: 2, paddingBottom: 10, gap: 8 } as const;

function ChipRow(props: { readonly trailing?: ReactNode; readonly children: ReactNode }) {
  return (
    <View className="flex-row items-start">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        className="flex-1"
        contentContainerStyle={ROW_STYLE}
      >
        {props.children}
      </ScrollView>
      {props.trailing ? <View className="bg-screen pl-2 pr-4 pt-0.5">{props.trailing}</View> : null}
    </View>
  );
}

/** Project chips alone, for lists whose environment filter lives elsewhere. */
export function ProjectFilterChips(props: ProjectChipProps) {
  if (props.projects.length < 2 && !props.trailing) return null;
  return (
    <ChipRow trailing={props.trailing}>
      {props.projects.length > 1 ? <ProjectChips {...props} /> : null}
    </ChipRow>
  );
}

export function ThreadListFilters(
  props: Pick<
    HomeHeaderProps,
    | "environments"
    | "projects"
    | "selectedEnvironmentId"
    | "selectedProjectKey"
    | "onEnvironmentChange"
    | "onProjectChange"
  > &
    Pick<ProjectChipProps, "indicatorByProjectKey" | "trailing">,
) {
  const selectedEnvironment = props.environments.find(
    (environment) => environment.environmentId === props.selectedEnvironmentId,
  );
  return (
    <ChipRow trailing={props.trailing}>
      <ListFilterMenu
        label={selectedEnvironment?.label ?? "All environments"}
        accessibilityLabel="Filter threads by environment"
        active={selectedEnvironment !== undefined}
        actions={[
          {
            id: "all",
            title: "All environments",
            state: props.selectedEnvironmentId === null ? "on" : "off",
          },
          ...props.environments.map((environment) => ({
            id: JSON.stringify(environment.environmentId),
            title: environment.label,
            state:
              environment.environmentId === props.selectedEnvironmentId
                ? ("on" as const)
                : ("off" as const),
          })),
        ]}
        onSelect={(id) => {
          if (id === "all") props.onEnvironmentChange(null);
          else {
            const environment = props.environments.find(
              (candidate) => JSON.stringify(candidate.environmentId) === id,
            );
            if (environment) props.onEnvironmentChange(environment.environmentId);
          }
        }}
      />
      {props.projects.length > 1 ? <ProjectChips {...props} /> : null}
      {props.selectedEnvironmentId !== null || props.selectedProjectKey !== null ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Reset thread filters"
          className="h-8 w-8 items-center justify-center"
          onPress={() => {
            props.onEnvironmentChange(null);
            props.onProjectChange(null);
          }}
        >
          <SymbolView name="xmark.circle.fill" size={18} tintColorClassName="accent-icon-muted" />
        </Pressable>
      ) : null}
    </ChipRow>
  );
}
