import { useState } from "react";
import { TabsContent } from "@/components/ui/tabs";
import { MainLayout } from "@/components/layout/MainLayout";
import { CreateProject } from "@/components/create/CreateProject";
import { ProjectsTab } from "@/components/projects/ProjectsTab";
import { FinishedVideos } from "@/components/finished/FinishedVideos";

const Index = () => {
  const [activeTab, setActiveTab] = useState("create");
  const [lastCreatedProjectId, setLastCreatedProjectId] = useState<string | null>(null);

  const handleProjectCreated = (projectId: string) => {
    setLastCreatedProjectId(projectId);
    setActiveTab("projects");
  };

  return (
    <MainLayout activeTab={activeTab} onTabChange={setActiveTab}>
      <TabsContent value="create" className="mt-6">
        <CreateProject onProjectCreated={handleProjectCreated} />
      </TabsContent>
      <TabsContent value="projects" className="mt-6">
        <ProjectsTab initialProjectId={lastCreatedProjectId} />
      </TabsContent>
      <TabsContent value="finished" className="mt-6">
        <FinishedVideos />
      </TabsContent>
    </MainLayout>
  );
};

export default Index;
