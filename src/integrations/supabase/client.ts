import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://hcfgqxlpwlvmtiriothl.supabase.co';
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhjZmdxeGxwd2x2bXRpcmlvdGhsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjgyNjA4MzgsImV4cCI6MjA4MzgzNjgzOH0.AU1tmUK6Wg5vDnQuXCWw61yYM2oBwk3sr55xLScaiI4';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
