import { useState } from "react";
import { TabsContent } from "@/components/ui/tabs";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MainLayout } from "@/components/layout/MainLayout";
import { CreateProject } from "@/components/create/CreateProject";
import { MusicVideoCreate } from "@/components/create/MusicVideoCreate";
import { ProjectsTab } from "@/components/projects/ProjectsTab";
import { FinishedVideos } from "@/components/finished/FinishedVideos";
import { GenerateContent } from "@/components/generate/GenerateContent";
import { Mic, Music } from "lucide-react";

const Index = () => {
  const [activeTab, setActiveTab] = useState("create");
  const [lastCreatedProjectId, setLastCreatedProjectId] = useState<string | null>(null);
  const [createMode, setCreateMode] = useState<"narration" | "music">("narration");

  const handleProjectCreated = (projectId: string) => {
    setLastCreatedProjectId(projectId);
    setActiveTab("projects");
  };

  return (
    <MainLayout activeTab={activeTab} onTabChange={setActiveTab}>
      <TabsContent value="create" className="mt-6">
        <div className="mb-6 flex justify-center">
          <Tabs value={createMode} onValueChange={(v) => setCreateMode(v as "narration" | "music")}>
            <TabsList className="grid grid-cols-2 w-[300px]">
              <TabsTrigger value="narration" className="flex items-center gap-2">
                <Mic className="h-4 w-4" />
                Narration
              </TabsTrigger>
              <TabsTrigger value="music" className="flex items-center gap-2">
                <Music className="h-4 w-4" />
                Music Video
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        {createMode === "narration" ? (
          <CreateProject onProjectCreated={handleProjectCreated} />
        ) : (
          <MusicVideoCreate onProjectCreated={handleProjectCreated} />
        )}
      </TabsContent>
      <TabsContent value="projects" className="mt-6">
        <ProjectsTab initialProjectId={lastCreatedProjectId} />
      </TabsContent>
      <TabsContent value="finished" className="mt-6">
        <FinishedVideos />
      </TabsContent>
      <TabsContent value="generate" className="mt-6">
        <GenerateContent onProjectCreated={handleProjectCreated} />
      </TabsContent>
    </MainLayout>
  );
};

export default Index;
