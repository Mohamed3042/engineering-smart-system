import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useSession, useWorkspace } from "@/api/session";
import { useAiStatus, useCanManage } from "@/features/connections/api";
import { knowledgeSources, useLearningProgress, useScanJob, useScanJobs, useStartScan } from "@/features/knowledge/api";
import { DiscoveryProgress, ScanProgress } from "@/features/knowledge/components/DiscoveryProgress";
import { Banner, Button, ErrorState, toastError } from "@/ui";
import { StepHeader, StepNav } from "./StepFrame";

/**
 * Step 7: read the mailbox, then learn from mail and folders. One button starts the mailbox scan; when it has
 * finished, business learning starts by itself. Both run in the background, so leaving the page is fine.
 */
export function LearningStep() {
  const canManage = useCanManage();
  const workspace = useWorkspace();
  const mailReady = useSession().data?.mail?.status === "connected";
  const ai = useAiStatus();
  const progress = useLearningProgress();
  const sources = knowledgeSources(workspace);
  const jobs = useScanJobs();
  const startScan = useStartScan();
  const [jobId, setJobId] = useState<string | null>(null);
  const chain = useRef(false);

  // follow the scan started here, or one still running from before
  const running = jobs.data?.find((j) => j.status === "queued" || j.status === "running");
  const followed = jobId ?? running?.id ?? jobs.data?.[0]?.id ?? null;
  const job = useScanJob(followed);
  const scanning = job.data?.status === "queued" || job.data?.status === "running";

  // the scan was started here and has finished: learn from what it read
  const learn = progress.start.mutate;
  useEffect(() => {
    const status = job.data?.status;
    if (!chain.current || !status) return;
    if (status === "done") {
      chain.current = false;
      learn({ folders: sources.folders, web: sources.web }, { onError: (err) => toastError(err, "Learning did not start") });
    } else if (status === "failed" || status === "cancelled") {
      chain.current = false;
    }
  }, [job.data?.status, learn, sources.folders, sources.web]);

  async function start() {
    if (!mailReady) {
      progress.start.mutate({ folders: sources.folders, web: sources.web }, { onError: (err) => toastError(err, "Learning did not start") });
      return;
    }
    try {
      const created = await startScan.mutateAsync({});
      setJobId(created.id);
      chain.current = true;
    } catch (err) {
      toastError(err, "The mailbox scan did not start");
    }
  }

  const learning = progress.phase === "running" || progress.phase === "starting" || progress.phase === "stalled";
  const finished = progress.phase === "done";

  return (
    <>
      <StepHeader
        title="Learn from your mail and documents"
        description="The app reads the mailbox for the period you chose, then your company folders, and suggests what your company does. You decide what is kept."
      />
      <div className="space-y-6">
        {!mailReady ? (
          <Banner
            tone="review"
            title="No mailbox is connected"
            actions={
              <Button asChild size="sm" variant="secondary">
                <Link to="/setup/mail">Connect the mailbox</Link>
              </Button>
            }
          >
            Learning will use company folders only. Connect a mailbox to read your enquiries and quotations as well.
          </Banner>
        ) : null}
        {ai.data?.rules_only ? (
          <Banner tone="review" title="No eligible AI model is connected">
            Learning still runs, with rules only, so expect fewer and simpler findings. You can run it again after connecting an engine.
          </Banner>
        ) : null}

        {progress.query.isError ? <ErrorState error={progress.query.error} onRetry={() => progress.query.refetch()} compact /> : null}

        {job.data && (jobId !== null || scanning) ? (
          <ScanProgress
            job={job.data}
            action={
              job.data.status === "failed" ? (
                <>
                  <Button size="sm" variant="secondary" disabled={!canManage || startScan.isPending} onClick={() => void start()}>
                    Try the scan again
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!canManage || progress.start.isPending}
                    onClick={() => progress.start.mutate({ folders: sources.folders, web: sources.web }, { onError: (err) => toastError(err, "Learning did not start") })}
                  >
                    Learn from folders only
                  </Button>
                </>
              ) : undefined
            }
          />
        ) : null}

        <DiscoveryProgress
          progress={progress}
          folders={sources.folders}
          web={sources.web}
          canRun={canManage}
          onStart={() => void start()}
          startBusy={startScan.isPending || progress.start.isPending}
          startDisabled={scanning}
        />
      </div>

      <StepNav
        continueDisabled={!finished}
        reason={learning || scanning ? "Learning is running. It continues if you leave." : "Start learning, or skip."}
        continueLabel="Review what it found"
        skip="Skip for now"
        skipHint="Nothing is learned yet. Run it later from Settings, under Business knowledge."
      />
    </>
  );
}
