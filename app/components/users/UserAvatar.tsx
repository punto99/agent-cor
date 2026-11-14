import { getInitials, type InternalUser } from "@/app/lib/internalUsers";

export function UserAvatar({
  user,
  size = "md",
}: {
  user: InternalUser;
  size?: "md" | "lg";
}) {
  const classes = size === "lg" ? "h-12 w-12 text-base" : "h-9 w-9 text-sm";
  const initials = getInitials(user.name, user.email);

  if (user.image) {
    return (
      <img
        src={user.image}
        alt={user.name}
        className={`${classes} rounded-full object-cover`}
      />
    );
  }

  return (
    <div
      className={`${classes} flex shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground font-medium`}
    >
      {initials}
    </div>
  );
}
