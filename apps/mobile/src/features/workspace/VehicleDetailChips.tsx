import {
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import type { vehicleDetailCopy } from "./vehicleDetailCopy";

export function VehicleDetailChips({
  vehicle,
  copy,
  styles,
}: {
  vehicle: { mileage: number; fuelType?: string; transmission?: string };
  copy: ReturnType<typeof vehicleDetailCopy>;
  styles: {
    heroChipRow: StyleProp<ViewStyle>;
    heroChip: StyleProp<ViewStyle>;
    heroChipText: StyleProp<TextStyle>;
  };
}) {
  return (
    <View style={styles.heroChipRow}>
      <View style={styles.heroChip}>
        <Text style={styles.heroChipText}>
          {copy.formatMileage(vehicle.mileage)}
        </Text>
      </View>
      {vehicle.fuelType ? (
        <View style={styles.heroChip}>
          <Text style={styles.heroChipText}>
            {copy.fuelLabel(vehicle.fuelType)}
          </Text>
        </View>
      ) : null}
      {vehicle.transmission ? (
        <View style={styles.heroChip}>
          <Text style={styles.heroChipText}>
            {copy.transmissionLabel(vehicle.transmission)}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
