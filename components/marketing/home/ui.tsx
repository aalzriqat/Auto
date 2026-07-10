import { motion } from "framer-motion";
import type { FeatureGridItem } from "./content";

interface FeatureCardGridProps {
  features: FeatureGridItem[];
  locale: string;
  gridClassName: string;
  cardClassName: string;
  iconWrapClassName: string;
  titleClassName: string;
  descClassName: string;
  delayStep: number;
}

export function FeatureCardGrid({
  features,
  locale,
  gridClassName,
  cardClassName,
  iconWrapClassName,
  titleClassName,
  descClassName,
  delayStep,
}: FeatureCardGridProps) {
  return (
    <div className={gridClassName}>
      {features.map((feature, idx) => {
        const Icon = feature.icon;

        return (
          <motion.div
            key={idx}
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, delay: idx * delayStep }}
            className={cardClassName}
          >
            <div className={iconWrapClassName}>
              <Icon className="w-5 h-5 text-blue-400" />
            </div>
            <div>
              <h3 className={titleClassName}>{locale === "ar" ? feature.titleAr : feature.titleEn}</h3>
              <p className={descClassName}>{locale === "ar" ? feature.descAr : feature.descEn}</p>
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}
