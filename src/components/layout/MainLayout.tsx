import { ReactNode } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Film, FolderOpen, Video, LogOut } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import logoSvg from "@/assets/logo.svg";

interface MainLayoutProps {
  activeTab: string;
  onTabChange: (tab: string) => void;
  children: ReactNode;
}

export function MainLayout({ activeTab, onTabChange, children }: MainLayoutProps) {
  const { user, signOut } = useAuth();

  const handleSignOut = async () => {
    await signOut();
    toast.success("Signed out successfully");
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="border-b border-border bg-card">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <img src={logoSvg} alt="StillDawn" className="h-8 w-8" />
              <h1 className="text-2xl font-bold">StillDawn</h1>
            </div>
            <div className="flex items-center gap-4">
              <span className="text-sm text-muted-foreground hidden sm:inline">
                {user?.email}
              </span>
              <Button variant="ghost" size="sm" onClick={handleSignOut}>
                <LogOut className="h-4 w-4 mr-2" />
                Sign out
              </Button>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content with Tabs */}
      <main className="container mx-auto px-4 py-6">
        <Tabs value={activeTab} onValueChange={onTabChange} className="w-full">
          <TabsList className="grid w-full max-w-md grid-cols-3 bg-muted">
            <TabsTrigger value="create" className="flex items-center gap-2 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              <Film className="h-4 w-4" />
              Create
            </TabsTrigger>
            <TabsTrigger value="projects" className="flex items-center gap-2 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              <FolderOpen className="h-4 w-4" />
              Projects
            </TabsTrigger>
            <TabsTrigger value="finished" className="flex items-center gap-2 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
              <Video className="h-4 w-4" />
              Finished
            </TabsTrigger>
          </TabsList>
          {children}
        </Tabs>
      </main>
    </div>
  );
}
