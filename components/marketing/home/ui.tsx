import { motion } from "framer-motion";
import type { FeatureGridItem } from "./content";

type FeatureCardGridProps = Readonly<{
  features: readonly FeatureGridItem[];
  locale: string;
  gridClassName: string;
  cardClassName: string;
  iconWrapClassName: string;
  titleClassName: string;
  descClassName: string;
  delayStep: number;
}>;

function localize(locale: string, english: string, arabic: string) {
  return locale === "ar" ? arabic : english;
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
            key={feature.titleEn}
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
              <h3 className={titleClassName}>{localize(locale, feature.titleEn, feature.titleAr)}</h3>
              <p className={descClassName}>{localize(locale, feature.descEn, feature.descAr)}</p>
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}
