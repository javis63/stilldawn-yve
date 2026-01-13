import { useState, useEffect, useCallback } from "react";
import { Project } from "@/types/project";
import { ProjectsList } from "./ProjectsList";
import { ProjectDetails } from "./ProjectDetails";
import { Card, CardContent } from "@/components/ui/card";
import { FolderOpen } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

interface ProjectsTabProps {
  initialProjectId?: string | null;
}

export function ProjectsTab({ initialProjectId }: ProjectsTabProps) {
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // Auto-select project when initialProjectId changes
  useEffect(() => {
    const fetchAndSelectProject = async () => {
      if (initialProjectId && !selectedProject) {
        const { data, error } = await supabase
          .from("projects")
          .select("*")
          .eq("id", initialProjectId)
          .single();

        if (!error && data) {
          setSelectedProject(data as Project);
        }
      }
    };

    fetchAndSelectProject();
  }, [initialProjectId]);

  const handleSelectProject = (project: Project) => {
    setSelectedProject(project);
  };

  const handleRefresh = useCallback(async () => {
    // Refresh the selected project data
    if (selectedProject) {
      const { data, error } = await supabase
        .from("projects")
        .select("*")
        .eq("id", selectedProject.id)
        .single();

      if (!error && data) {
        setSelectedProject(data as Project);
      }
    }
    // Trigger projects list refresh
    setRefreshKey(prev => prev + 1);
  }, [selectedProject]);

  return (
    <div className="flex gap-6 min-h-[70vh]">
      {/* Left Sidebar - Projects List */}
      <div className="w-80 shrink-0">
        <Card className="h-full bg-card border-border">
          <ProjectsList
            key={refreshKey}
            selectedProjectId={selectedProject?.id || null}
            onSelectProject={handleSelectProject}
          />
        </Card>
      </div>

      {/* Right Panel - Project Details */}
      <div className="flex-1">
        {selectedProject ? (
          <ProjectDetails project={selectedProject} onRefresh={handleRefresh} />
        ) : (
          <Card className="h-full bg-card border-border">
            <CardContent className="flex flex-col items-center justify-center h-full py-20 text-center">
              <FolderOpen className="h-20 w-20 text-muted-foreground mb-4" />
              <h3 className="text-xl font-medium text-foreground mb-2">
                Select a Project
              </h3>
              <p className="text-muted-foreground max-w-sm">
                Choose a project from the list to view and edit its scenes, or create a new project from the Create tab.
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
