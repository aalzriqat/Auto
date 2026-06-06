const fs = require('fs');

const path = 'e:/Auto/Auto/components/vehicles/VehicleDialog.tsx';
let content = fs.readFileSync(path, 'utf8');

content = content.replace('import { useState, useEffect } from "react";', 'import { useState, useEffect, useRef } from "react";');
content = content.replace('import { Button } from "@/components/ui/button";', 'import { Button } from "@/components/ui/button";\nimport { Upload, X } from "lucide-react";');

// Update schema
content = content.replace(
  'notes: z.string().optional(),',
  'notes: z.string().optional(),\n  imageIds: z.array(z.string()).optional(),'
);

// Inside VehicleDialog component
const stateVars = `
  const generateUploadUrl = useMutation(api.vehicles.generateUploadUrl);
  const deleteImage = useMutation(api.vehicles.deleteImage);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [imageIds, setImageIds] = useState<string[]>([]);
  const [imageUrls, setImageUrls] = useState<string[]>([]);
`;

content = content.replace('const [isSubmitting, setIsSubmitting] = useState(false);', 'const [isSubmitting, setIsSubmitting] = useState(false);' + stateVars);

// Update defaultValues
content = content.replace(
  'notes: "",',
  'notes: "",\n      imageIds: [],'
);

// Update reset logic
const resetEdit = `        notes: vehicle.notes || "",
        imageIds: vehicle.imageIds || [],
      });
      setImageIds(vehicle.imageIds || []);
      setImageUrls((vehicle as any).imageUrls || []);`;

content = content.replace('        notes: vehicle.notes || "",\n      });', resetEdit);

const resetNew = `        notes: "",
        imageIds: [],
      });
      setImageIds([]);
      setImageUrls([]);`;
content = content.replace('        notes: "",\n      });', resetNew);

// Add upload handlers
const handlers = `
  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !activeOrgId) return;

    setIsUploading(true);
    try {
      const newImageIds = [...imageIds];
      const newImageUrls = [...imageUrls];

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const postUrl = await generateUploadUrl({ orgId: activeOrgId });
        const result = await fetch(postUrl, {
          method: "POST",
          headers: { "Content-Type": file.type },
          body: file,
        });
        const { storageId } = await result.json();
        newImageIds.push(storageId);
        newImageUrls.push(URL.createObjectURL(file));
      }

      setImageIds(newImageIds);
      setImageUrls(newImageUrls);
      form.setValue("imageIds", newImageIds);
    } catch (error) {
      toast.error("Failed to upload image");
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleRemoveImage = async (index: number) => {
    const storageId = imageIds[index];
    const newImageIds = [...imageIds];
    const newImageUrls = [...imageUrls];
    newImageIds.splice(index, 1);
    newImageUrls.splice(index, 1);
    setImageIds(newImageIds);
    setImageUrls(newImageUrls);
    form.setValue("imageIds", newImageIds);

    // If it's saved on the server, we might want to delete it from storage
    if (vehicle && activeOrgId) {
      try {
        await deleteImage({ orgId: activeOrgId, vehicleId: vehicle._id, storageId: storageId as Id<"_storage"> });
      } catch (err) {
        console.error("Failed to delete image from server", err);
      }
    }
  };
`;

content = content.replace('const onSubmit = async (values: VehicleFormValues) => {', handlers + '\n  const onSubmit = async (values: VehicleFormValues) => {');

// Add values.imageIds to create/update
content = content.replace('...values,', '...values,\n          imageIds: imageIds as Id<"_storage">[],');
content = content.replace('...values,', '...values,\n          imageIds: imageIds as Id<"_storage">[],'); // replace the second one

// Add UI for image upload before the actions
const imageUI = `
            </div>
            
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <FormLabel>Vehicle Images</FormLabel>
                <div>
                  <input 
                    type="file" 
                    accept="image/*" 
                    multiple 
                    className="hidden" 
                    ref={fileInputRef} 
                    onChange={handleUpload} 
                  />
                  <Button 
                    type="button" 
                    variant="outline" 
                    size="sm" 
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isUploading}
                  >
                    <Upload className="w-4 h-4 mr-2" />
                    {isUploading ? "Uploading..." : "Upload Images"}
                  </Button>
                </div>
              </div>
              
              {imageUrls.length > 0 ? (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-2">
                  {imageUrls.map((url, index) => (
                    <div key={index} className="relative group aspect-video bg-muted rounded-md overflow-hidden border">
                      <img src={url} alt={\`Vehicle \${index + 1}\`} className="object-cover w-full h-full" />
                      <button
                        type="button"
                        onClick={() => handleRemoveImage(index)}
                        className="absolute top-1 right-1 bg-black/50 text-white p-1 rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="border-2 border-dashed rounded-lg p-8 text-center text-muted-foreground bg-muted/20">
                  <Upload className="w-8 h-8 mx-auto mb-2 opacity-50" />
                  <p>No images uploaded yet</p>
                </div>
              )}
            </div>
`;

content = content.replace('</div>\n            <div className="flex justify-end gap-2">', imageUI + '\n            <div className="flex justify-end gap-2 pt-4">');

fs.writeFileSync('e:/Auto/Auto/components/vehicles/VehicleDialog.tsx', content);
console.log('VehicleDialog.tsx updated');
