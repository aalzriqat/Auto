"use client";

import * as React from "react";
import { format } from "date-fns";
import { Calendar as CalendarIcon, Clock } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";

interface DateTimePickerProps {
  value?: Date;
  onChange?: (date: Date) => void;
  className?: string;
}

export function DateTimePicker({ value, onChange, className }: DateTimePickerProps) {
  const [date, setDate] = React.useState<Date | undefined>(value);
  const [time, setTime] = React.useState<string>(
    value ? format(value, "HH:mm") : "09:00"
  );
  
  // Keep internal state in sync with external value
  React.useEffect(() => {
    if (value) {
      setDate(value);
      setTime(format(value, "HH:mm"));
    }
  }, [value]);

  const handleDateSelect = (selectedDate: Date | undefined) => {
    if (selectedDate) {
      // Apply existing time to the newly selected date
      const [hours, minutes] = time.split(":").map(Number);
      selectedDate.setHours(hours || 0);
      selectedDate.setMinutes(minutes || 0);
      selectedDate.setSeconds(0);
      selectedDate.setMilliseconds(0);
      
      setDate(selectedDate);
      if (onChange) onChange(selectedDate);
    } else {
      setDate(undefined);
    }
  };

  const handleTimeChange = (newTime: string) => {
    setTime(newTime);
    
    if (date) {
      const [hours, minutes] = newTime.split(":").map(Number);
      const newDate = new Date(date);
      newDate.setHours(hours || 0);
      newDate.setMinutes(minutes || 0);
      newDate.setSeconds(0);
      newDate.setMilliseconds(0);
      
      setDate(newDate);
      if (onChange) onChange(newDate);
    }
  };

  return (
    <Popover modal={true}>
      <PopoverTrigger asChild>
        <Button
          variant={"outline"}
          className={cn(
            "w-full justify-start text-left font-normal",
            !date && "text-muted-foreground",
            className
          )}
        >
          <CalendarIcon className="mr-2 h-4 w-4" />
          {date ? format(date, "PPP p") : <span>Pick a date and time</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={date}
          onSelect={handleDateSelect}
          initialFocus
        />
        <div className="p-3 border-t border-border flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Clock className="h-4 w-4" />
            <span>Time</span>
          </div>
          <div className="flex items-center gap-1">
            <select
              value={time.split(":")[0]}
              onChange={(e) => handleTimeChange(e.target.value + ":" + time.split(":")[1])}
              className="flex h-9 w-[60px] items-center justify-center rounded-md border border-input bg-transparent px-2 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
            >
              {Array.from({ length: 24 }).map((_, i) => {
                const val = i.toString().padStart(2, "0");
                return <option key={val} value={val}>{val}</option>;
              })}
            </select>
            <span className="text-muted-foreground font-medium">:</span>
            <select
              value={time.split(":")[1]}
              onChange={(e) => handleTimeChange(time.split(":")[0] + ":" + e.target.value)}
              className="flex h-9 w-[60px] items-center justify-center rounded-md border border-input bg-transparent px-2 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
            >
              {["00", "05", "10", "15", "20", "25", "30", "35", "40", "45", "50", "55"].map((val) => (
                <option key={val} value={val}>{val}</option>
              ))}
            </select>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
