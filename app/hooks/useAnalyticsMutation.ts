"use client";

import { useConvex, useMutation } from "convex/react";
import type { FunctionReference, FunctionReturnType, OptionalRestArgs } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

type SourceId = Id<"tasks"> | Id<"projects"> | Id<"taskEvaluations">;

export function useAnalyticsMutation<Mutation extends FunctionReference<"mutation">>(
  mutation: Mutation,
  sources: (result: FunctionReturnType<Mutation>, args: OptionalRestArgs<Mutation>[0]) => (SourceId | undefined)[],
) {
  const mutate = useMutation(mutation);
  const convex = useConvex();
  return async (...args: OptionalRestArgs<Mutation>): Promise<FunctionReturnType<Mutation>> => {
    const result = await mutate(...args);
    try {
      const sourceIds = sources(result, args[0]).filter((id): id is SourceId => id !== undefined);
      if (sourceIds.length) {
        void convex.action(api.analytics.jobs.hint, { sourceIds }).catch(error => {
          console.error("[analytics] Could not notify committed changes", error);
        });
      }
    } catch (error) {
      console.error("[analytics] Could not prepare committed changes", error);
    }
    return result;
  };
}
