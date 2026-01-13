import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Card } from "@/components/ui/card";
import { Search, RefreshCw, FolderOpen, Clock, Film } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Project } from "@/types/project";
import { formatDistanceToNow } from "date-fns";

interface ProjectsListProps {
  selectedProjectId: string | null;
  onSelectProject: (project: Project) => void;
}

export function ProjectsList({ selectedProjectId, onSelectProject }: ProjectsListProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");

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
  }, []);

  const filteredProjects = projects.filter((project) =>
    project.title.toLowerCase().includes(searchQuery.toLowerCase())
  );

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
          <h2 className="font-semibold text-foreground">Projects</h2>
          <Button
            variant="ghost"
            size="icon"
            onClick={fetchProjects}
            disabled={loading}
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
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
                      </span>
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {formatDistanceToNow(new Date(project.created_at), { addSuffix: true })}
                      </span>
                    </div>
                  </div>
                </div>
              </Card>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
