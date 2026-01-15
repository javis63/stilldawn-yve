export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      projects: {
        Row: {
          audio_duration: number | null
          audio_url: string | null
          created_at: string
          id: string
          progress: number | null
          project_type: Database["public"]["Enums"]["project_type"]
          status: Database["public"]["Enums"]["project_status"]
          thumbnail_scene_id: string | null
          title: string
          transcript: string | null
          updated_at: string
          user_id: string | null
          word_timestamps: Json | null
        }
        Insert: {
          audio_duration?: number | null
          audio_url?: string | null
          created_at?: string
          id?: string
          progress?: number | null
          project_type?: Database["public"]["Enums"]["project_type"]
          status?: Database["public"]["Enums"]["project_status"]
          thumbnail_scene_id?: string | null
          title: string
          transcript?: string | null
          updated_at?: string
          user_id?: string | null
          word_timestamps?: Json | null
        }
        Update: {
          audio_duration?: number | null
          audio_url?: string | null
          created_at?: string
          id?: string
          progress?: number | null
          project_type?: Database["public"]["Enums"]["project_type"]
          status?: Database["public"]["Enums"]["project_status"]
          thumbnail_scene_id?: string | null
          title?: string
          transcript?: string | null
          updated_at?: string
          user_id?: string | null
          word_timestamps?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "projects_thumbnail_scene_id_fkey"
            columns: ["thumbnail_scene_id"]
            isOneToOne: false
            referencedRelation: "scenes"
            referencedColumns: ["id"]
          },
        ]
      }
      renders: {
        Row: {
          created_at: string
          duration: number | null
          error_message: string | null
          id: string
          project_id: string
          seo_description: string | null
          seo_hashtags: string | null
          seo_keywords: string | null
          seo_title: string | null
          status: Database["public"]["Enums"]["render_status"]
          subtitle_srt: string | null
          subtitle_vtt: string | null
          thumbnail_url: string | null
          updated_at: string
          video_url: string | null
        }
        Insert: {
          created_at?: string
          duration?: number | null
          error_message?: string | null
          id?: string
          project_id: string
          seo_description?: string | null
          seo_hashtags?: string | null
          seo_keywords?: string | null
          seo_title?: string | null
          status?: Database["public"]["Enums"]["render_status"]
          subtitle_srt?: string | null
          subtitle_vtt?: string | null
          thumbnail_url?: string | null
          updated_at?: string
          video_url?: string | null
        }
        Update: {
          created_at?: string
          duration?: number | null
          error_message?: string | null
          id?: string
          project_id?: string
          seo_description?: string | null
          seo_hashtags?: string | null
          seo_keywords?: string | null
          seo_title?: string | null
          status?: Database["public"]["Enums"]["render_status"]
          subtitle_srt?: string | null
          subtitle_vtt?: string | null
          thumbnail_url?: string | null
          updated_at?: string
          video_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "renders_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      scenes: {
        Row: {
          created_at: string
          end_time: number
          id: string
          image_url: string | null
          image_urls: string[] | null
          narration: string
          project_id: string
          scene_number: number
          scene_type: Database["public"]["Enums"]["scene_type"]
          start_time: number
          transition: Database["public"]["Enums"]["transition_type"]
          updated_at: string
          video_url: string | null
          visual_prompt: string | null
        }
        Insert: {
          created_at?: string
          end_time: number
          id?: string
          image_url?: string | null
          image_urls?: string[] | null
          narration: string
          project_id: string
          scene_number: number
          scene_type?: Database["public"]["Enums"]["scene_type"]
          start_time: number
          transition?: Database["public"]["Enums"]["transition_type"]
          updated_at?: string
          video_url?: string | null
          visual_prompt?: string | null
        }
        Update: {
          created_at?: string
          end_time?: number
          id?: string
          image_url?: string | null
          image_urls?: string[] | null
          narration?: string
          project_id?: string
          scene_number?: number
          scene_type?: Database["public"]["Enums"]["scene_type"]
          start_time?: number
          transition?: Database["public"]["Enums"]["transition_type"]
          updated_at?: string
          video_url?: string | null
          visual_prompt?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "scenes_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      project_status:
        | "draft"
        | "processing"
        | "ready"
        | "rendering"
        | "completed"
        | "error"
      project_type: "narration" | "music"
      render_status: "queued" | "rendering" | "completed" | "failed"
      scene_type: "image" | "video"
      transition_type:
        | "crossfade"
        | "hard_cut"
        | "zoom_in"
        | "zoom_out"
        | "fade_to_black"
        | "slide_left"
        | "slide_right"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      project_status: [
        "draft",
        "processing",
        "ready",
        "rendering",
        "completed",
        "error",
      ],
      project_type: ["narration", "music"],
      render_status: ["queued", "rendering", "completed", "failed"],
      scene_type: ["image", "video"],
      transition_type: [
        "crossfade",
        "hard_cut",
        "zoom_in",
        "zoom_out",
        "fade_to_black",
        "slide_left",
        "slide_right",
      ],
    },
  },
} as const
