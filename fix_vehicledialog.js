const fs = require('fs');

const path = 'e:/Auto/Auto/components/vehicles/VehicleDialog.tsx';
let content = fs.readFileSync(path, 'utf8');

const onSubmitCode = `
  const onSubmit = async (values: VehicleFormValues) => {
    if (!activeOrgId) return;
    setIsSubmitting(true);
    try {
      const { imageIds: _formImageIds, ...restValues } = values;

      if (vehicle) {
        await updateVehicle({
          orgId: activeOrgId,
          vehicleId: vehicle._id,
          ...restValues,
          imageIds: imageIds as Id<"_storage">[],
        });
        toast.success("Vehicle updated successfully");
      } else {
        await createVehicle({
          orgId: activeOrgId,
          ...restValues,
          imageIds: imageIds as Id<"_storage">[],
        });
        toast.success("Vehicle added successfully");
      }
      onOpenChange(false);
    } catch (error: any) {
      toast.error(error.message || "Something went wrong");
    } finally {
      setIsSubmitting(false);
    }
  };
`;

content = content.replace(/  };\n\n      setIsSubmitting\(false\);\n    }\n  };\n/, `  };\n${onSubmitCode}\n`);

fs.writeFileSync(path, content);
console.log("Fixed VehicleDialog.tsx");
