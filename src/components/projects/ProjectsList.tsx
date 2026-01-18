import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Search, RefreshCw, FolderOpen, Clock, Film, Trash2, Archive, ArchiveRestore, MoreVertical } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Project } from "@/types/project";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";

interface ProjectsListProps {
  selectedProjectId: string | null;
  onSelectProject: (project: Project) => void;
}

export function ProjectsList({ selectedProjectId, onSelectProject }: ProjectsListProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [projectToDelete, setProjectToDelete] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchProjects = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("projects")
        .select("*")
        .order("created_at", { ascending: false });

      if (error) throw error;
      setProjects(data || []);
    } catch (error) {
      console.error("Error fetching projects:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProjects();

    // Subscribe to realtime updates for progress tracking
    const channel = supabase
      .channel('projects-progress')
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'projects',
        },
        (payload) => {
          console.log('Project update:', payload);
          const updatedProject = payload.new as Project;
          setProjects((prev) =>
            prev.map((p) =>
              p.id === updatedProject.id ? { ...p, ...updatedProject } : p
            )
          );
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const handleDeleteProject = async () => {
    if (!projectToDelete) return;
    
    setDeleting(true);
    try {
      // Delete associated renders first (cascades will handle scenes)
      const { error: rendersError } = await supabase
        .from("renders")
        .delete()
        .eq("project_id", projectToDelete.id);
      
      if (rendersError) throw rendersError;

      // Delete associated scenes
      const { error: scenesError } = await supabase
        .from("scenes")
        .delete()
        .eq("project_id", projectToDelete.id);
      
      if (scenesError) throw scenesError;

      // Delete the project
      const { error: projectError } = await supabase
        .from("projects")
        .delete()
        .eq("id", projectToDelete.id);
      
      if (projectError) throw projectError;

      toast.success("Project deleted successfully");
      setProjects((prev) => prev.filter((p) => p.id !== projectToDelete.id));
      
      // Clear selection if deleted project was selected
      if (selectedProjectId === projectToDelete.id) {
        onSelectProject(null as any);
      }
    } catch (error: any) {
      console.error("Error deleting project:", error);
      toast.error(error.message || "Failed to delete project");
    } finally {
      setDeleting(false);
      setDeleteDialogOpen(false);
      setProjectToDelete(null);
    }
  };

  const handleArchiveProject = async (project: Project, archive: boolean) => {
    try {
      const { error } = await supabase
        .from("projects")
        .update({ archived: archive })
        .eq("id", project.id);

      if (error) throw error;

      setProjects((prev) =>
        prev.map((p) =>
          p.id === project.id ? { ...p, archived: archive } as Project : p
        )
      );
      
      toast.success(archive ? "Project archived" : "Project restored");
    } catch (error: any) {
      console.error("Error archiving project:", error);
      toast.error(error.message || "Failed to archive project");
    }
  };

  // Filter projects by search and archived status
  const filteredProjects = projects.filter((project) => {
    const matchesSearch = project.title.toLowerCase().includes(searchQuery.toLowerCase());
    const isArchived = (project as any).archived === true;
    return matchesSearch && (showArchived ? isArchived : !isArchived);
  });

  const getStatusColor = (status: string) => {
    switch (status) {
      case "completed":
        return "text-green-400";
      case "rendering":
        return "text-yellow-400";
      case "ready":
        return "text-blue-400";
      case "processing":
        return "text-orange-400";
      case "error":
        return "text-red-400";
      default:
        return "text-muted-foreground";
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b border-border space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-foreground">
            {showArchived ? "Archived Projects" : "Projects"}
          </h2>
          <div className="flex items-center gap-1">
            <Button
              variant={showArchived ? "secondary" : "ghost"}
              size="icon"
              onClick={() => setShowArchived(!showArchived)}
              title={showArchived ? "Show active projects" : "Show archived projects"}
            >
              {showArchived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={fetchProjects}
              disabled={loading}
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search projects..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 bg-background border-border"
          />
        </div>
      </div>

      {/* Projects List */}
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-2">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : filteredProjects.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <FolderOpen className="h-12 w-12 text-muted-foreground mb-2" />
              <p className="text-muted-foreground">
                {searchQuery ? "No projects found" : "No projects yet"}
              </p>
            </div>
          ) : (
            filteredProjects.map((project) => (
              <Card
                key={project.id}
                className={`p-3 cursor-pointer transition-colors border ${
                  selectedProjectId === project.id
                    ? "border-primary bg-primary/10"
                    : "border-border hover:border-primary/50 bg-card"
                }`}
                onClick={() => onSelectProject(project)}
              >
                <div className="flex items-start gap-3">
                  <Film className="h-5 w-5 text-primary mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-foreground truncate">
                      {project.title}
                    </p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className={`text-xs capitalize ${getStatusColor(project.status)}`}>
                        {project.status}
                        {project.status === "processing" && project.progress && project.progress > 0 && (
                          <span className="ml-1">({project.progress}%)</span>
                        )}
                      </span>
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {formatDistanceToNow(new Date(project.created_at), { addSuffix: true })}
                      </span>
                    </div>
                    {project.status === "processing" && project.progress && project.progress > 0 && (
                      <Progress value={project.progress} className="h-1 mt-2" />
                    )}
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground shrink-0"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                      <DropdownMenuItem
                        onClick={() => handleArchiveProject(project, !(project as any).archived)}
                      >
                        {(project as any).archived ? (
                          <>
                            <ArchiveRestore className="h-4 w-4 mr-2" />
                            Restore
                          </>
                        ) : (
                          <>
                            <Archive className="h-4 w-4 mr-2" />
                            Archive
                          </>
                        )}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={() => {
                          setProjectToDelete(project);
                          setDeleteDialogOpen(true);
                        }}
                      >
                        <Trash2 className="h-4 w-4 mr-2" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </Card>
            ))
          )}
        </div>
      </ScrollArea>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Project</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{projectToDelete?.title}"? This will also delete all scenes and rendered videos associated with this project. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteProject}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
